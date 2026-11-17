// SPDX-License-Identifier: MIT
//
// The playground page: a case (bench/cases) in this browser (an iframe) and
// in RangerDOM (rangerdom_pg.wasm or rangerdom_pg.js: the page's scripts in
// CEr with webapi.js, its render tree laid out by EVG, the display list
// drawn by evg-webgl.js),
// the same steps in both, timed.
//
//   ?case=<name>     open that case
//   &auto=1          run its steps at once; window.__pgResult has the result
//   &engine=wasm|js  RangerDOM as WebAssembly (default; cargo build of
//                    playground/wasm) or as JavaScript (rangerdom_pg.js)
//   &size=W,H        the page's viewport (default 1200,800)
//   &delta=0         each render sends the whole page to the layout, not
//                    only what changed since the last one
//   &sync=0          sizes read after a change come from the last frame's
//                    layout (default: laid out at once, as a browser does)
//   &budget=ms       once a step took longer than this in RangerDOM, the
//                    case's later steps run in the browser only (default
//                    5000; 0 runs every step). The JavaScript build of CEr
//                    is slow, and a 10 000-row step can exhaust the tab.
import { renderDisplayList, fontSpec } from "./evg-webgl.js";
import { installCanvasMeasurer } from "./evg-measure.js";
import { loadWasmPlayground } from "./rangerdom-wasm.js";
import { createA11yMirror, pressAtCentre } from "./evg-a11y.js";

const params = new URLSearchParams(location.search);
const [W, H] = (params.get("size") || "1200,800").split(",").map(Number);
const BUDGET = params.has("budget") ? Number(params.get("budget")) : 5000;
const DPR = Math.min(2, window.devicePixelRatio || 1);
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const frame = () => new Promise((ok) => requestAnimationFrame(() => ok()));
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v) ? "–" : v < 10 ? v.toFixed(1) : Math.round(v).toString());

let mod = null; // rangerdom_pg.js, loaded only for the JavaScript engine
let Engine = null; // the Playground class main() picks
let engineName = "";
const canvas = $("rd");
const iframe = $("native");
canvas.width = Math.round(W * DPR);
canvas.height = Math.round(H * DPR);
canvas.style.width = W + "px";
canvas.style.height = H + "px";
iframe.style.width = W + "px";
iframe.style.height = H + "px";
const gl = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true, stencil: true, preserveDrawingBuffer: true });

// both panes scaled to the column
function fit() {
  for (const [box, el] of [[$("nativeBox"), iframe], [$("rdBox"), canvas]]) {
    const s = Math.min(1, box.clientWidth / W);
    el.style.transform = `scale(${s})`;
    box.style.height = Math.ceil(H * s) + "px";
    el.dataset.scale = s;
  }
}
window.addEventListener("resize", fit);

// ------------------------------------------------------------- RangerDOM
let pg = null;
let busy = false;
let errors = [];
// frames: the frames shown while the step ran (each followed by a wait
// for the display), gap: the longest time between two of them (from the
// step's start); the browser's are counted the same way, with its own
// animation frames (nativeRun)
const acc = { render: 0, layout: 0, paint: 0, gl: 0, frames: 0, gap: 0, gaps: [], last: 0, counting: true };
function resetAcc() { acc.render = acc.layout = acc.paint = acc.gl = acc.frames = acc.gap = 0; acc.gaps = []; acc.last = performance.now(); acc.counting = true; }

// SVG pictures of background-image (Bootstrap's form icons, its select's
// arrow, the close button): EVG names each by pngPart's hash of its URL
// (DomView bg-picture), the painter takes them from this map. Each is
// drawn once into a canvas at the device's pixels; the page is painted
// again when one has come in.
const pictures = new Map(); // name -> canvas (null while it loads)
const loadedPictures = new Map();
let lastList = null;
function pictureName(url) {
  const b = new TextEncoder().encode(url);
  let h = 5381;
  for (const x of b) h = (h * 33 + x) % 2147483647;
  return `dompng-${b.length}-${h}`;
}
// (as DomView::bgSvgUrl: the first url(), quoted or not)
function bgSvgUrl(v) {
  const at = v.indexOf("url(");
  if (at < 0) return "";
  let u = v.slice(at + 4).trim(), close = ")";
  if (u[0] === '"' || u[0] === "'") { close = u[0] + ")"; u = u.slice(1); }
  const end = u.indexOf(close);
  if (end < 0) return "";
  u = u.slice(0, end);
  return /^data:image\/svg\+xml/i.test(u.slice(0, 32)) ? u : "";
}
function scanPictures(json) {
  if (!json || json.indexOf("data:image/svg") < 0) return;
  for (const m of json.matchAll(/"background-image":"((?:[^"\\]|\\.)*)"/g)) {
    let v;
    try { v = JSON.parse('"' + m[1] + '"'); } catch (_) { continue; }
    const u = bgSvgUrl(v);
    if (!u) continue;
    const name = pictureName(u);
    if (pictures.has(name)) continue;
    pictures.set(name, null);
    const img = new Image();
    img.onload = () => {
      // (the viewBox's ratio when the picture has no size of its own)
      let w = img.naturalWidth || 300, h = img.naturalHeight || 150;
      let txt = "";
      try { txt = decodeURIComponent(u.slice(u.indexOf(",") + 1)); } catch (_) {}
      const vb = /viewBox=['"]\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(txt);
      if (vb && !/<svg[^>]*\swidth=/.test(txt)) { w = +vb[1]; h = +vb[2]; }
      const k = Math.min(8, Math.max(1, 64 / Math.max(w, h))) * DPR;
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(w * k));
      c.height = Math.max(1, Math.round(h * k));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      pictures.set(name, c);
      loadedPictures.set(name, c);
      if (lastList && gl) paintGl(lastList);
    };
    img.src = u;
  }
}
const fullScanned = new Set();
function missingPicture(list) {
  const cmds = Array.isArray(list) ? list : list && (list.cmds || Object.values(list).find(Array.isArray));
  if (!cmds) return false;
  let miss = false;
  for (const c of cmds) {
    if (c.k === 2 && typeof c.src === "string" && c.src.startsWith("dompng-") && !pictures.has(c.src) && !fullScanned.has(c.src)) { fullScanned.add(c.src); miss = true; }
  }
  return miss;
}
// (a picture drawn at an opacity, the alpha of its command's colour: the
// WebGL painter draws pictures opaque, so a faded copy is drawn once and
// named for it, Bootstrap's half-transparent close button)
function fadedPictures(list) {
  const cmds = Array.isArray(list) ? list : list && (list.cmds || Object.values(list).find(Array.isArray));
  if (!cmds) return;
  for (const c of cmds) {
    if (c.k !== 2 || !c.c || !(c.c[3] < 1) || typeof c.src !== "string" || c.src.indexOf("@") >= 0) continue;
    const base = loadedPictures.get(c.src);
    if (!base) continue;
    const a = Math.round(c.c[3] * 100) / 100, name = `${c.src}@${a}`;
    if (!loadedPictures.has(name)) {
      const f = document.createElement("canvas");
      f.width = base.width; f.height = base.height;
      const g = f.getContext("2d");
      g.globalAlpha = a;
      g.drawImage(base, 0, 0);
      loadedPictures.set(name, f);
    }
    c.src = name;
  }
}
function paintGl(list) {
  fadedPictures(list);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  renderDisplayList(gl, { width: W, height: H, list }, { dpr: DPR, images: loadedPictures });
}

// the page as it is now: render tree, EVG layout (boxes back), display list, WebGL
function draw() {
  let t = performance.now();
  scanPictures(pg.render());
  let t2 = performance.now();
  acc.render += t2 - t;
  pg.layout();
  t = performance.now();
  acc.layout += t - t2;
  const list = JSON.parse(pg.paint());
  t2 = performance.now();
  acc.paint += t2 - t;
  lastList = list;
  // (a picture of a node the delta renders did not carry, one unchanged
  // since the first render: the whole render tree is looked through once)
  if (missingPicture(list)) scanPictures(pg.eval("__render()"));
  if (gl) paintGl(list);
  const end = performance.now();
  acc.gl += end - t2;
  if (acc.counting) {
    acc.frames++;
    acc.gap = Math.max(acc.gap, end - acc.last);
    acc.gaps.push(Math.round(end - acc.last));
    acc.last = end;
  }
}
function drain() {
  let msgs = [];
  try { msgs = JSON.parse(pg.messages() || "[]"); } catch (_) {}
  for (const m of msgs) {
    if (m.tag === "pick-file") { pickFiles(m); continue; }
    if (m.tag === "error") errors.push(m.text);
    else if (m.tag === "console" && m.level === "error") errors.push(m.text);
    else if (m.tag === "console" && m.text.startsWith("[bench] ")) {
      try { const o = JSON.parse(m.text.slice(8)); if (o.error) errors.push(o.error); } catch (_) {}
    }
  }
}
// a file field's chooser in RangerDOM is this browser's: the chosen files
// go to the page (webapi.js __setFiles), up to 16 MB each
// (one input kept in the document: a detached one can be collected while
// the chooser is open, and its change never comes)
let filePicker = null;
function pickFiles(m) {
  if (!filePicker) {
    filePicker = document.createElement("input");
    filePicker.type = "file";
    filePicker.style.display = "none";
    filePicker.tabIndex = -1;
    document.body.appendChild(filePicker);
    filePicker.addEventListener("change", async () => {
      const id = filePicker.dataset.id, out = [];
      for (const f of filePicker.files) {
        if (f.size > 16 << 20) continue;
        const bytes = new Uint8Array(await f.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        out.push({ name: f.name, type: f.type, lastModified: f.lastModified, b64: btoa(bin) });
      }
      filePicker.value = "";
      if (pg && out.length) pg.eval("__setFiles(" + id + ", " + JSON.stringify(JSON.stringify(out)) + ")");
    });
  }
  filePicker.dataset.id = JSON.stringify(m.id);
  filePicker.multiple = !!m.multiple;
  filePicker.accept = m.accept || "";
  filePicker.click();
}
let clock = 0;
function tick() {
  const now = performance.now();
  pg.tick(Math.max(0, now - clock));
  clock = now;
}
// timers and frames until `done()` (or the time is up), then until the page
// stops changing
async function pump(done, ms) {
  const end = performance.now() + ms;
  for (;;) {
    tick();
    const drew = pg.dirty();
    if (drew) draw();
    drain();
    if (done()) break;
    if (performance.now() > end) { errors.push(`timed out after ${ms} ms`); break; }
    const due = pg.dueIn();
    // (what was drawn is shown before the page's next frame runs)
    if (due === 0 && !drew) await sleep(0); else await frame();
  }
  acc.counting = false;
  // (a page's animation frames run one per tick: the frames it has asked
  // for are given their 17 ms each here, without the wait, and the page is
  // drawn when none is due; what the layout then tells the page may ask
  // for more)
  for (let k = 0; k < 24; k++) {
    pg.tick(k === 0 ? 0 : 17);
    const due = pg.dueIn();
    if (due >= 0 && due <= 17 && k < 20) continue;
    if (!pg.dirty()) break;
    draw();
  }
  drain();
}
function realmValue(src) { return pg.eval(src); }
// (for a console or a headless check: an expression evaluated in the page in RangerDOM)
window.__rdEval = (src) => (pg ? pg.eval(src) : "");
window.__rdPaint = () => (pg ? pg.paint() : "");
async function rdRun(call, ms) {
  // (the page's clock starts the step where it is: while the browser ran
  // its side, nothing ticked here, and the first tick gave the page's
  // timers and transitions that whole time at once, a 0.15 s fade ended
  // before it was drawn)
  clock = performance.now();
  realmValue("window.__pgDone = ''; (" + call + ").then(function (r) { __pgDone = JSON.stringify(r) || 'null'; }, function (e) { __pgDone = JSON.stringify({ error: String(e) }); })");
  let out = "";
  await pump(() => (out = realmValue("__pgDone")) !== "", ms);
  let line = null;
  try { line = JSON.parse(out); } catch (_) {}
  return line;
}
const rdProbe = () => { try { return JSON.parse(realmValue("JSON.stringify(window.__benchCase && __benchCase.probe ? __benchCase.probe() : null)")); } catch (e) { return { probeError: String(e) }; } };

async function rdLoad(name) {
  const base = new URL(`cases/${name}/`, location.href).href;
  const html = await (await fetch(base + "index.html")).text();
  pg = new Engine();
  pg.reset();
  for (const src of [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])) {
    pg.addScript(new URL(src, base).href, await (await fetch(base + src)).text());
    if (pg.addUnit) {
      // compiled by the build (CEr's code cache), as a browser keeps its own
      const u = await fetch(base + src + ".unit").catch(() => null);
      if (u && u.ok) pg.addUnit(new URL(src, base).href, await u.text());
    }
  }
  errors = [];
  resetAcc();
  const t0 = performance.now();
  pg.start(html, base + "index.html", W, H);
  // ?sync=0: a size read after a change waits for the next frame's layout
  if (params.get("sync") === "0") pg.eval("__syncLayout(false)");
  // ?delta=0: each render sends the whole page to the layout, not what changed
  if (params.get("delta") === "0") pg.eval("__deltaRender(false)");
  pg.runScripts();
  clock = performance.now();
  draw();
  drain();
  return performance.now() - t0;
}

// ------------------------------------------------------------- the browser
function nativeLoad(name) {
  return new Promise((ok) => {
    const t0 = performance.now();
    iframe.onload = () => ok(performance.now() - t0);
    iframe.src = `cases/${name}/index.html`;
  });
}
async function nativeRun(call) {
  const w = iframe.contentWindow;
  const t0 = performance.now();
  // the browser's frames while the step runs (its animation frames: a
  // main thread busy with the step skips them)
  const fr = { n: 0, gap: 0, last: t0, on: true };
  const count = () => {
    if (!fr.on) return;
    const now = performance.now();
    fr.n++;
    fr.gap = Math.max(fr.gap, now - fr.last);
    fr.last = now;
    w.requestAnimationFrame(count);
  };
  w.requestAnimationFrame(count);
  let line = null;
  try { line = await call(w.__bench); } catch (e) { line = { error: String(e) }; }
  fr.on = false;
  await new Promise((ok) => w.requestAnimationFrame(() => w.requestAnimationFrame(() => ok())));
  const drawn = performance.now() - t0;
  let probe = null;
  try { probe = w.__benchCase && w.__benchCase.probe ? JSON.parse(JSON.stringify(w.__benchCase.probe())) : null; } catch (e) { probe = { probeError: String(e) }; }
  return { line, drawn, probe, frames: fr.n, gap: fr.gap };
}

// ------------------------------------------------------------- the picture
// What the browser drew and what RangerDOM drew, compared where it can be
// told without a screenshot of the iframe (a page cannot take one):
//   flat points: a grid over the viewport; where the browser has a plain
//     background (no text, image, border, shadow, gradient or control
//     within 3 px) its colour is the backgrounds there composited with
//     their opacities, and the canvas pixel there has to be that colour.
//     Catches translucent colours blended wrongly, missing or extra fills.
//   text: each visible run of text in the browser has to leave some ink
//     in the same rectangle of the canvas. Catches a body drawn blank.
// The probe says what the page reports; this says what it shows.
const PIC_GRID = 24; // px between flat points
const PIC_TOL = 48; // |dr| + |dg| + |db|
// (a colour of another space, oklch() or color-mix(), as the browser
// draws it in sRGB: one pixel of a 2D canvas)
let colorCtx = null;
function drawnColor(v) {
  if (!colorCtx) colorCtx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d", { willReadFrequently: true });
  colorCtx.clearRect(0, 0, 1, 1);
  colorCtx.fillStyle = "rgba(0, 0, 0, 0)";
  colorCtx.fillStyle = v;
  colorCtx.fillRect(0, 0, 1, 1);
  const d = colorCtx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3] / 255];
}
function rgbaOf(v) {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/.exec(v || "");
  if (!m) return /^(oklch|oklab|lab|lch|hwb|hsla?|color)\(/.test(v || "") ? drawnColor(v) : null;
  let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4];
  return [+m[1], +m[2], +m[3], a];
}
const PLAIN_SKIP = /^(img|svg|canvas|video|iframe|input|select|textarea|button|option|progress|meter|object|embed|picture|path|use|image|hr)$/i;
// the colour the browser shows at (x, y), or null when it is not a plain
// background there: every box stacked at the point (elementsFromPoint, top
// first), the same 3 px around (no edge of any of them near), their
// background colours composited with their opacities over the white page
function flatColor(w, x, y, opacityOf) {
  const d = w.document;
  const st = d.elementsFromPoint(x, y);
  if (!st.length) return null;
  for (const [dx, dy] of [[-3, 0], [3, 0], [0, -3], [0, 3]]) {
    const o = d.elementsFromPoint(x + dx, y + dy);
    if (o.length !== st.length || o.some((e, i) => e !== st[i])) return null;
  }
  const layers = [];
  for (const e of st) {
    if (PLAIN_SKIP.test(e.localName) || e.namespaceURI !== "http://www.w3.org/1999/xhtml" || e.shadowRoot) return null;
    const cs = w.getComputedStyle(e);
    if (cs.backgroundImage !== "none" || cs.boxShadow !== "none" || cs.filter !== "none" || (cs.backdropFilter && cs.backdropFilter !== "none") || cs.mixBlendMode !== "normal" || (cs.maskImage && cs.maskImage !== "none") || (cs.webkitMaskImage && cs.webkitMaskImage !== "none")) return null;
    if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) return null;
    const r = e.getBoundingClientRect();
    const side = (k) => (cs["border" + k + "Style"] !== "none" ? parseFloat(cs["border" + k + "Width"]) || 0 : 0);
    const bl = side("Left"), bt = side("Top"), br = side("Right"), bb = side("Bottom");
    if ((bl && x < r.left + bl + 3) || (bt && y < r.top + bt + 3) || (br && x > r.right - br - 3) || (bb && y > r.bottom - bb - 3)) return null;
    // over its scroll bar
    if (cs.overflow !== "visible" && e.clientWidth && (x > r.left + e.clientLeft + e.clientWidth - 1 || y > r.top + e.clientTop + e.clientHeight - 1)) return null;
    // text of its own near the point
    for (const t of e.childNodes) {
      if (t.nodeType !== 3 || !t.data.trim()) continue;
      const range = d.createRange();
      range.selectNodeContents(t);
      for (const q of range.getClientRects()) if (x > q.left - 3 && x < q.right + 3 && y > q.top - 3 && y < q.bottom + 3) return null;
    }
    const c = rgbaOf(cs.backgroundColor), op = opacityOf(e);
    if (c && c[3] > 0) layers.push([c, c[3] * op]);
    if (c && c[3] >= 1 && op >= 1) break;
  }
  let col = [255, 255, 255];
  for (let i = layers.length - 1; i >= 0; i--) {
    const [c, a] = layers[i];
    col = [0, 1, 2].map((k) => col[k] * (1 - a) + c[k] * a);
  }
  return col;
}
// the runs of text the browser shows, as rectangles in the viewport
function textRuns(w, max, opacityOf) {
  const d = w.document, out = [];
  const walk = d.createTreeWalker(d.body || d.documentElement, 4);
  for (let t = walk.nextNode(); t && out.length < max; t = walk.nextNode()) {
    if (!t.data.trim()) continue;
    const p = t.parentElement;
    if (!p || /^(script|style|noscript|option|textarea|title)$/i.test(p.localName)) continue;
    const cs = w.getComputedStyle(p);
    if (cs.visibility !== "visible" || +cs.opacity < 0.3 || cs.color === "transparent" || (rgbaOf(cs.color) || [0, 0, 0, 1])[3] < 0.3) continue;
    const range = d.createRange();
    range.selectNodeContents(t);
    for (const q of range.getClientRects()) {
      if (q.width < 4 || q.height < 6 || q.left < 0 || q.top < 0 || q.right > W || q.bottom > H) continue;
      if (d.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2) !== p && !p.contains(d.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2))) continue;
      out.push([q.left, q.top, q.width, q.height, opacityOf ? opacityOf(p) : 1]);
      if (out.length >= max) break;
    }
  }
  return out;
}

// form controls: the flat points and text runs above leave them out (a
// field's value is no text node), so each visible text field, select,
// checkbox and radio is looked at here, against where the browser puts
// what it shows (its own font metrics, measured in the page):
//   text: the value (or placeholder) leaves ink in the field's content box,
//     vertically centred as the browser centres it (a field's one line is
//     centred in its content box)
//   caret: the focused field with no selection shows a caret at the
//     selection's offset: a column of ink about the font's height
//   selection: the focused field's selection is drawn as a band
//   checked: a checked checkbox or radio is filled, an unchecked one not
const TEXT_FIELD = /^(text|search|tel|url|email|password|number)$/;
const DATE_FIELD = /^(date|time|datetime-local|month|week)$/;
function controlsCheck(w, at, opacityOf) {
  const d = w.document, out = { fields: 0, bad: [] };
  const mctx = d.createElement("canvas").getContext("2d");
  const step = 1 / DPR;
  const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const name = (el) => el.id ? "#" + el.id : el.getAttribute("name") ? `${el.localName}[name=${el.getAttribute("name")}]` : el.className && typeof el.className === "string" ? `${el.localName}.${el.className.trim().split(/\s+/)[0]}` : el.localName;
  const bad = (el, what) => { if (out.bad.length < 12) out.bad.push(`${name(el)}: ${what}`); };
  // the focused element's outline (a :focus or :focus-visible rule's):
  // the middle of its top and left edges in the outline's colour
  const fe = d.activeElement;
  if (fe && fe !== d.body && fe.nodeType === 1) {
    const cs = w.getComputedStyle(fe), ow = parseFloat(cs.outlineWidth) || 0, oc = rgbaOf(cs.outlineColor);
    const r = fe.getBoundingClientRect();
    if (cs.outlineStyle !== "none" && cs.outlineStyle !== "auto" && ow >= 1.5 && oc && oc[3] > 0.6 && r.width > 10 && r.height > 6 && r.left > ow + 4 && r.top > ow + 4 && r.right < W - ow - 4 && r.bottom < H - ow - 4) {
      const o = (parseFloat(cs.outlineOffset) || 0) + ow / 2;
      const pts = [[r.left + r.width / 2, r.top - o], [r.left - o, r.top + r.height / 2], [r.left + r.width / 2, r.bottom + o]];
      if (pts.filter(([x, y]) => diff(at(x, y), oc) > 90).length >= 2) bad(fe, "focused, outline not drawn");
    }
  }
  for (const el of d.querySelectorAll("input, textarea, select")) {
    const ln = el.localName, type = ln === "input" ? el.type : ln;
    const box = ln === "input" && (type === "checkbox" || type === "radio");
    const listbox = ln === "select" && (el.multiple || el.size > 1);
    const drawn = ln === "input" && /^(color|range|file)$/.test(type);
    const dateLike = ln === "input" && DATE_FIELD.test(type);
    const text = ln === "textarea" || (ln === "select" && !listbox) || (ln === "input" && TEXT_FIELD.test(type)) || dateLike;
    if (!box && !text && !listbox && !drawn) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.left < 0 || r.top < 0 || r.right > W || r.bottom > H) continue;
    const cs = w.getComputedStyle(el);
    if (cs.visibility !== "visible" || opacityOf(el) < 0.5) continue;
    const hit = d.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit !== el && !(hit && el.contains(hit))) continue;
    out.fields++;
    if (box) {
      // (a point inside the mark, off the radio's dot and the tick's
      // centre: the filled box or ring there, white when unchecked)
      const p = type === "radio" ? at(r.left + r.width / 2, r.top + r.height / 2) : at(r.left + r.width * 0.25, r.top + r.height * 0.25);
      const white = diff(p, [255, 255, 255]);
      if (el.checked && white < 60) bad(el, "checked but drawn empty");
      if (!el.checked && !el.indeterminate && white > 200) bad(el, "unchecked but drawn filled");
      continue;
    }
    if (type === "color") {
      // the swatch: its middle in the value's colour
      const c = at(r.left + r.width / 2, r.top + r.height / 2), want = rgbaOf(drawnColor(el.value).slice(0, 3).join(",").replace(/^/, "rgb(") + ")");
      if (diff(c, want) > 60) bad(el, `swatch rgb(${c.map(Math.round)}) for ${el.value}`);
      continue;
    }
    if (type === "range") {
      // the thumb (Chromium's: 16 px) at the value's share of the track
      const mn = el.min === "" ? 0 : +el.min, mx = el.max === "" ? 100 : +el.max, f = mx > mn ? (+el.value - mn) / (mx - mn) : 0;
      const tx = r.left + 8 + f * (r.width - 16), ty = r.top + r.height / 2;
      const thumb = [[0, 0], [-3, 0], [3, 0], [0, -4], [0, 4]].filter(([dx, dy]) => diff(at(tx + dx, ty + dy), [255, 255, 255]) > 150).length;
      if (thumb < 4) bad(el, `no thumb at ${Math.round(f * 100)} % (x ${Math.round(tx)})`);
      continue;
    }
    if (type === "file" || listbox) {
      // text in it: the button's label, or each option shown
      const rows = listbox ? [...el.options].map((o) => o.getBoundingClientRect()).filter((q) => q.height > 4 && q.bottom <= r.bottom - 1) : [r];
      let blank = 0;
      for (const q of rows) {
        let ink = false;
        const x0 = q.left + 2, x1 = Math.min(q.right - 2, q.left + 60);
        for (let y = q.top + 2; y < q.bottom - 2 && !ink; y += step) for (let x = x0; x < x1; x += step) { const c = at(x, y); if (diff(c, at(x1 + 1 > q.right - 1 ? q.right - 3 : x1 + 1, q.top + 1)) > 150 || Math.max(...c) < 120) { ink = true; break; } }
        if (!ink) blank++;
      }
      if (blank) bad(el, listbox ? `${blank} of ${rows.length} options not drawn` : "no button text");
      continue;
    }
    const px = (k) => parseFloat(cs[k]) || 0;
    const cl = r.left + px("borderLeftWidth") + px("paddingLeft"), ct = r.top + px("borderTopWidth") + px("paddingTop");
    const cw = r.width - px("borderLeftWidth") - px("borderRightWidth") - px("paddingLeft") - px("paddingRight");
    const ch = r.height - px("borderTopWidth") - px("borderBottomWidth") - px("paddingTop") - px("paddingBottom");
    if (cw < 6 || ch < 4) continue;
    // (a date's own text is Chromium's, unknown here: one of its length)
    let shown = ln === "select" ? (el.selectedOptions[0] ? el.selectedOptions[0].text : "") : dateLike ? "11/15/2026" : el.value;
    let color = cs.color;
    if (!shown && ln !== "select") { shown = el.placeholder || ""; color = w.getComputedStyle(el, "::placeholder").color; }
    if (type === "password" && el.value) shown = "•".repeat(el.value.length);
    const col = rgbaOf(color) || [0, 0, 0, 1];
    if (col[3] < 0.3) continue;
    mctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    const fm = mctx.measureText("Hg"), fa = fm.fontBoundingBoxAscent, fd = fm.fontBoundingBoxDescent, fsz = parseFloat(cs.fontSize) || 13;
    const lh = cs.lineHeight === "normal" ? fa + fd : parseFloat(cs.lineHeight) || fa + fd;
    const multi = ln === "textarea";
    const lineTop = multi ? ct - el.scrollTop : ct + (ch - lh) / 2;
    const base = lineTop + (lh - (fa + fd)) / 2 + fa;
    const start = (cs.textAlign === "start" || cs.textAlign === "left" || cs.textAlign === "-webkit-auto") && cs.direction !== "rtl";
    const focused = d.activeElement === el && ln !== "select" && !dateLike;
    let ss = null, se = null;
    try { ss = el.selectionStart; se = el.selectionEnd; } catch (_) {}
    if (focused && ss === null) ss = se = el.value.length; // (email, number: the caret after typing)
    const offX = (n) => cl - el.scrollLeft + mctx.measureText((type === "password" ? shown : el.value).slice(0, n).split("\n").pop()).width;
    const lineOf = (n) => el.value.slice(0, n).split("\n").length - 1;
    // the field's background: a point of the content box past the text,
    // else the padding
    const tw = shown ? mctx.measureText(multi ? shown.split("\n")[0] : shown).width : 0;
    // (halfway from the text's end to the box's: not a picker icon at the end)
    const bgAt = start && tw < cw - 8 ? at(cl + tw + (cw - tw) / 2, multi ? ct + 3 : ct + ch / 2) : at(r.left + px("borderLeftWidth") + Math.min(2, px("paddingLeft") / 2), r.top + r.height / 2);
    const inkMin = 70 * Math.min(1, col[3]);
    if (shown && !(focused && ss !== se)) {
      // ink rows: rows with 3 or more ink pixels (a caret is one wide),
      // not a line across the whole width (a border drawn elsewhere)
      const x0 = start ? cl : r.left + px("borderLeftWidth"), x1 = start ? Math.min(cl + cw, cl + tw + 1) : r.right - px("borderRightWidth");
      const y0 = multi ? ct : r.top + px("borderTopWidth"), y1 = multi ? Math.min(r.bottom, ct + lh) : r.bottom - px("borderBottomWidth");
      let top = null, bottom = null;
      for (let y = y0 + 1; y < y1 - 1; y += step) {
        let n = 0, all = 0;
        for (let x = x0 + 0.5; x < x1; x += step) { all++; if (diff(at(x, y), bgAt) > inkMin) n++; }
        if (n >= 3 && n < all * 0.85) { if (top === null) top = y; bottom = y; }
      }
      if (top === null) bad(el, `${el.value ? "value" : "placeholder"} not drawn`);
      else if (!multi) {
        const ink = mctx.measureText(shown);
        const want = base + (ink.actualBoundingBoxDescent - ink.actualBoundingBoxAscent) / 2, got = (top + bottom) / 2;
        if (Math.abs(got - want) > Math.max(2.5, fsz * 0.18)) bad(el, `text ${got > want ? "below" : "above"} the centre by ${Math.abs(got - want).toFixed(1)} px`);
      }
    }
    if (!focused || !start) continue;
    const lt = multi ? ct - el.scrollTop + lineOf(se) * lh : lineTop, fh = fa + fd;
    const cb = lt + (lh - fh) / 2;
    if (ss === se && !el.readOnly) {
      const cx = offX(ss);
      if (cx < cl - 2 || cx > cl + cw + 2) continue;
      let found = false;
      for (let x = cx - 3; x <= cx + 3 && !found; x += step) {
        let run = 0;
        for (let y = cb - 2; y < cb + fh + 2; y += step) {
          if (diff(at(x, y), bgAt) > 90) { if (++run * step >= fh * 0.75) { found = true; break; } } else run = 0;
        }
      }
      if (!found) bad(el, `focused, no caret at offset ${ss} (x ${Math.round(cx)})`);
    } else {
      const bx0 = Math.max(cl, offX(ss)), bx1 = Math.min(cl + cw, offX(se));
      if (bx1 - bx0 < 4 || lineOf(ss) !== lineOf(se)) continue;
      let n = 0, on = 0;
      for (let x = bx0 + 1; x < bx1 - 1; x += 2) { n++; if (diff(at(x, cb + 1.5), bgAt) > 40) on++; }
      if (n && on < n * 0.6) bad(el, `selection ${ss}-${se} not drawn`);
    }
  }
  return out;
}
function pictureCheck() {
  const w = iframe.contentWindow;
  if (!gl || !w || !w.document || !w.document.body) return null;
  const pw = canvas.width, ph = canvas.height;
  const px = new Uint8Array(pw * ph * 4);
  gl.readPixels(0, 0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, px);
  // (premultiplied over the white page behind the canvas)
  const at = (x, y) => {
    const cx = Math.min(pw - 1, Math.max(0, Math.round(x * DPR))), cy = ph - 1 - Math.min(ph - 1, Math.max(0, Math.round(y * DPR)));
    const i = (cy * pw + cx) * 4, a = px[i + 3] / 255;
    return [px[i] + 255 * (1 - a), px[i + 1] + 255 * (1 - a), px[i + 2] + 255 * (1 - a)];
  };
  // (an element's opacity times its ancestors')
  const ops = new Map();
  const opacityOf = (e) => {
    if (!e || e.nodeType !== 1) return 1;
    let v = ops.get(e);
    if (v === undefined) { v = (+w.getComputedStyle(e).opacity) * opacityOf(e.parentElement); ops.set(e, v); }
    return v;
  };
  // boxes the pointer passes through are drawn all the same
  const unhide = w.document.createElement("style");
  unhide.textContent = "*, *::before, *::after { pointer-events: auto !important; }";
  (w.document.head || w.document.documentElement).appendChild(unhide);
  let points = 0, off = 0, worst = null;
  for (let y = PIC_GRID / 2; y < H; y += PIC_GRID) {
    for (let x = PIC_GRID / 2; x < W; x += PIC_GRID) {
      let want;
      try { want = flatColor(w, x, y, opacityOf); } catch (_) { want = null; }
      if (!want) continue;
      points++;
      // the nearest of the point and 2 px around it: a letter a pixel or
      // two away in RangerDOM is not a wrong background
      let got = null, dist = Infinity;
      for (const [dx, dy] of [[0, 0], [-2, 0], [2, 0], [0, -2], [0, 2]]) {
        const c = at(x + dx, y + dy);
        const dd = Math.abs(c[0] - want[0]) + Math.abs(c[1] - want[1]) + Math.abs(c[2] - want[2]);
        if (dd < dist) { dist = dd; got = c; }
      }
      if (dist > PIC_TOL) { off++; if (!worst || dist > worst.dist) worst = { x, y, dist: Math.round(dist), browser: want.map(Math.round), rangerdom: got.map(Math.round) }; }
    }
  }
  let runs = [];
  try { runs = textRuns(w, 400, opacityOf); } catch (_) {}
  let blank = 0, firstBlank = null;
  for (const [x, y, rw, rh, op] of runs) {
    // ink: a pixel that differs from the run's corner (its background);
    // faded text (opacity on it or an ancestor) differs by that much less
    const bg = at(x + 0.5, y + 0.5), inkMin = 90 * Math.min(1, op);
    let ink = false;
    for (let yy = y + 1; yy < y + rh - 1 && !ink; yy += 1 / DPR) {
      for (let xx = x + 1; xx < x + rw - 1; xx += 1 / DPR) {
        const c = at(xx, yy);
        if (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > inkMin) { ink = true; break; }
      }
    }
    if (!ink) { blank++; if (!firstBlank) firstBlank = [x, y, rw, rh].map(Math.round); }
  }
  let controls = null;
  try { controls = controlsCheck(w, at, opacityOf); } catch (e) { controls = { fields: 0, bad: ["check failed: " + e] }; }
  unhide.remove();
  // a few points or runs off is a font's edge or a frame of an animation
  const ok = off <= Math.max(2, points * 0.03) && blank <= Math.max(1, runs.length * 0.05) && !controls.bad.length;
  return { ok, points, off, worst, runs: runs.length, blank, firstBlank, controls };
}
function pictureText(p) {
  if (!p) return "";
  let t = `picture: ${p.off}/${p.points} flat points differ, ${p.blank}/${p.runs} text runs blank in RangerDOM`;
  if (p.worst) t += `\nworst point (${p.worst.x}, ${p.worst.y}): browser rgb(${p.worst.browser}), RangerDOM rgb(${p.worst.rangerdom})`;
  if (p.firstBlank) t += `\nfirst blank run at (${p.firstBlank[0]}, ${p.firstBlank[1]}) ${p.firstBlank[2]}×${p.firstBlank[3]}`;
  if (p.controls) t += `\nform controls: ${p.controls.bad.length} of ${p.controls.fields} wrong` + p.controls.bad.map((b) => "\n  " + b).join("");
  return t;
}

// ------------------------------------------------------------- a case
let cases = [];
let current = null;
let state = null; // { steps: [names], next, rows: [] }

// "frames · longest gap": how smooth the step looked
function framesText(x) {
  return x && x.frames !== undefined ? `${x.frames} · ${fmt(x.gap)}` : "";
}
function row(r) {
  const tr = document.createElement("tr");
  const sameProbe = JSON.stringify(r.nativeProbe) === JSON.stringify(r.rdProbe);
  const same = sameProbe && (!r.picture || r.picture.ok);
  r.same = same;
  const cells = [r.name, fmt(r.native.js), fmt(r.native.drawn), framesText(r.native), fmt(r.rd.js), fmt(r.rd.render), fmt(r.rd.layout), fmt(r.rd.paint), fmt(r.rd.gl), fmt(r.rd.drawn), framesText(r.rd)];
  for (const c of cells) { const td = document.createElement("td"); td.textContent = c; tr.appendChild(td); }
  const td = document.createElement("td");
  if (r.skipped) {
    r.same = null;
    td.textContent = "skipped";
    td.title = `RangerDOM: not run, an earlier step took over ${BUDGET} ms (?budget=0 runs every step)`;
    tr.appendChild(td);
    $("steps").tBodies[0].appendChild(tr);
    return;
  }
  td.className = same ? "ok" : "bad";
  td.textContent = same ? "yes" : "no";
  td.title = (sameProbe ? "the pages report the same" : "browser: " + JSON.stringify(r.nativeProbe) + "\nRangerDOM: " + JSON.stringify(r.rdProbe)) + (r.picture ? "\n" + pictureText(r.picture) : "");
  if (sameProbe && !same) td.textContent = "no (picture)";
  tr.appendChild(td);
  $("steps").tBodies[0].appendChild(tr);
}
function showErrors() {
  const pre = $("errors");
  pre.hidden = !errors.length;
  pre.textContent = errors.length ? "RangerDOM reported:\n" + [...new Set(errors)].slice(0, 30).join("\n") : "";
}
function setStatus(s) { $("status").textContent = s; }
function buttons(on) {
  for (const id of ["run", "step", "reload", "all"]) $(id).disabled = !on;
  if (on && state && state.next >= state.steps.length) $("step").disabled = $("run").disabled = true;
}

async function open(name) {
  busy = true;
  buttons(false);
  current = cases.find((c) => c.name === name) || cases[0];
  for (const b of $("cases").querySelectorAll("button")) b.setAttribute("aria-current", String(b.dataset.name === current.name));
  $("title").textContent = current.name;
  $("lib").textContent = current.lib + (current.area ? " · " + current.area : "");
  $("about").textContent = current.about;
  $("steps").tBodies[0].textContent = "";
  $("summary").hidden = true;
  history.replaceState(null, "", "?case=" + encodeURIComponent(current.name) + (params.get("size") ? "&size=" + params.get("size") : ""));
  setStatus("Loading…");
  const nLoad = await nativeLoad(current.name);
  const rLoad = await rdLoad(current.name);
  // setup: the case's own (fonts, libraries ready)
  const native = await nativeRun((b) => b.start());
  resetAcc();
  const t0 = performance.now();
  const rdLine = await rdRun("__bench.start()", 15000);
  const rdDrawn = performance.now() - t0;
  state = { steps: (native.line && native.line.steps) || (rdLine && rdLine.steps) || [], next: 0, rows: [] };
  const r = { name: "load + setup", native: { js: native.line && native.line.setup, drawn: nLoad + native.drawn }, rd: { js: rdLine && rdLine.setup, render: acc.render, layout: acc.layout, paint: acc.paint, gl: acc.gl, drawn: rLoad + rdDrawn }, nativeProbe: native.probe, rdProbe: rdProbe() };
  r.picture = pictureCheck();
  state.rows.push(r);
  row(r);
  showErrors();
  setStatus(`${state.steps.length} steps`);
  busy = false;
  buttons(true);
}

async function step() {
  if (!state || state.next >= state.steps.length) return null;
  busy = true;
  buttons(false);
  const k = state.next++;
  setStatus(`Step ${k + 1}/${state.steps.length}: ${state.steps[k]}`);
  const native = await nativeRun((b) => b.run(k));
  let r;
  if (state.over) {
    r = { name: state.steps[k], native: { js: native.line && native.line.total, drawn: native.drawn, frames: native.frames, gap: native.gap }, rd: {}, nativeProbe: native.probe, rdProbe: undefined, skipped: true };
  } else {
    resetAcc();
    const t0 = performance.now();
    const line = await rdRun(`__bench.run(${k})`, 20000);
    const drawn = performance.now() - t0;
    r = { name: state.steps[k], native: { js: native.line && native.line.total, drawn: native.drawn, frames: native.frames, gap: native.gap }, rd: { js: line && line.total, render: acc.render, layout: acc.layout, paint: acc.paint, gl: acc.gl, frames: acc.frames, gap: acc.gap, gaps: acc.gaps, drawn }, nativeProbe: native.probe, rdProbe: rdProbe() };
    r.picture = pictureCheck();
    if (BUDGET > 0 && drawn > BUDGET) state.over = true;
  }
  state.rows.push(r);
  row(r);
  showErrors();
  setStatus(state.next >= state.steps.length ? "Done" : `Step ${k + 1}/${state.steps.length} done`);
  busy = false;
  buttons(true);
  return r;
}
async function runAll() {
  while (state && state.next < state.steps.length) await step();
  return { case: current.name, rows: state.rows, errors: [...new Set(errors)] };
}

async function everyCase() {
  const out = [];
  for (const c of cases) {
    await open(c.name);
    const r = await runAll();
    const sum = (f) => r.rows.reduce((a, x) => a + (f(x) || 0), 0);
    out.push({ name: c.name, steps: r.rows.filter((x) => !x.skipped).length, skipped: r.rows.filter((x) => x.skipped).length, same: r.rows.filter((x) => x.same).length, native: sum((x) => x.native.drawn), rd: sum((x) => x.rd.drawn), nativeFrames: sum((x) => x.native.frames), rdFrames: sum((x) => x.rd.frames), nativeGap: Math.max(0, ...r.rows.map((x) => x.native.gap || 0)), rdGap: Math.max(0, ...r.rows.map((x) => x.rd.gap || 0)), errors: r.errors.length });
  }
  const div = $("summary");
  div.hidden = false;
  div.innerHTML = "<h3>Every case</h3><table><thead><tr><th>Case</th><th>Same result</th><th>Browser, until drawn (ms)</th><th>RangerDOM, until drawn (ms)</th><th>Frames · longest gap, browser</th><th>Frames · longest gap, RangerDOM</th><th>Errors</th></tr></thead><tbody>" +
    out.map((o) => `<tr><td>${o.name}</td><td>${o.same}/${o.steps}${o.skipped ? ` (${o.skipped} skipped)` : ""}</td><td>${fmt(o.native)}</td><td>${fmt(o.rd)}</td><td>${o.nativeFrames} · ${fmt(o.nativeGap)}</td><td>${o.rdFrames} · ${fmt(o.rdGap)}</td><td>${o.errors}</td></tr>`).join("") + "</tbody></table>";
  window.__pgEvery = out;
  return out;
}

// pointer on the canvas goes to the page in RangerDOM
function pagePoint(ev) {
  const s = Number(canvas.dataset.scale) || 1;
  const r = canvas.getBoundingClientRect();
  return { x: (ev.clientX - r.left) / s, y: (ev.clientY - r.top) / s };
}
for (const [evName, type] of [["pointerdown", "down"], ["pointerup", "up"], ["pointermove", "move"]]) {
  canvas.addEventListener(evName, (ev) => {
    if (!pg || busy) return;
    const p = pagePoint(ev);
    // (a press keeps the pointer: its moves and its release outside the
    // canvas still come here, as a browser's own page gets them)
    if (type === "down") { try { canvas.setPointerCapture(ev.pointerId); } catch (e) {} }
    // (t: when the press happened, the browser's own clock, for double clicks)
    pg.input(JSON.stringify({ type, x: p.x, y: p.y, t: ev.timeStamp, button: ev.button > 0 ? ev.button : 0, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey }));
    // (what the press asked of the host, a file chooser, in the press's own
    // task: browsers open a chooser only from a user gesture)
    if (type !== "move") { drain(); a11yDue = true; }
    // (the page's cursor: the CSS cursor of what the pointer is over)
    const cur = pg.eval("__cursor()");
    if (cur && canvas.style.cursor !== cur) canvas.style.cursor = cur;
  });
}
// the pointer leaving the canvas leaves the page: :hover ends there too
canvas.addEventListener("pointerleave", () => {
  if (!pg || busy) return;
  pg.input(JSON.stringify({ type: "leave" }));
  canvas.style.cursor = "";
});
// the wheel scrolls the page in RangerDOM (webapi.js: wheel event, then
// the scroll of the box under the pointer), keys go to its focused element
canvas.addEventListener("wheel", (ev) => {
  if (!pg || busy) return;
  ev.preventDefault();
  const p = pagePoint(ev);
  const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? H : 1;
  pg.input(JSON.stringify({ type: "wheel", x: p.x, y: p.y, dx: ev.deltaX * unit, dy: ev.deltaY * unit }));
}, { passive: false });
canvas.tabIndex = 0;
canvas.addEventListener("pointerdown", () => canvas.focus());
// (keys on the pane, so the screen reader mirror's focused element sends them too)
for (const [evName, type] of [["keydown", "key"], ["keyup", "keyup"]]) {
  $("rdBox").addEventListener(evName, (ev) => {
    if (!pg || busy) return;
    // (a mirror element types nothing itself: the page in RangerDOM does)
    if (ev.target !== canvas) ev.preventDefault();
    if (ev.key === "Tab" || ev.key.startsWith("Arrow") || ev.key === " " || ev.key === "Backspace" || ev.key === "Home" || ev.key === "End" || ev.key.startsWith("Page")) ev.preventDefault();
    pg.input(JSON.stringify({ type, key: ev.key, code: ev.code, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey }));
    drain();
    if (type === "key") a11yDue = true;
  });
}
// the page's accessible tree over the canvas (evg-a11y.js): the roles,
// names and states webapi.js gave each element, which DomView put on EVG's
// boxes and EVGA11yFromTree read back; a screen reader reads and moves
// through these elements, its presses go to the page where the element is,
// and the page's focus is the mirror's. ?a11y=0 turns it off.
// (a key or a press moves the focus: the next frame's update is not held back)
let mirror = null, a11yGen = 0, a11yAt = 0, a11yDue = false;
let paneFocus = false;
document.addEventListener("focusin", (ev) => { paneFocus = $("rdBox").contains(ev.target); });
document.addEventListener("pointerdown", (ev) => { if (!$("rdBox").contains(ev.target)) paneFocus = false; }, true);
const FOCUS_ID = "(function(){var e=document.activeElement;while(e&&e.shadowRoot&&e.shadowRoot.activeElement)e=e.shadowRoot.activeElement;return e&&e!==document.body&&e!==document.documentElement?'mfd-xd-0-'+e.__id:'';})()";
function a11yUpdate(force) {
  if (params.get("a11y") === "0" || !pg || typeof pg.a11y !== "function") return;
  const now = performance.now();
  if (!force && now - a11yAt < 400) return;
  a11yAt = now;
  if (!mirror) {
    mirror = createA11yMirror($("rdBox"), {
      canvas, label: "The case rendered by RangerDOM", scale: Number(canvas.dataset.scale) || 1,
      // (the page's focus moves the keyboard only while it is in the pane)
      // (or the focus fell to the body because the mirror element it was on
      // stopped being a tab stop as the page's focus moved on)
      canMoveFocus: () => $("rdBox").contains(document.activeElement) || (paneFocus && document.activeElement === document.body),
      onActivate: (node) => pressAtCentre(node, (x, y) => {
        pg.input(JSON.stringify({ type: "down", x, y, button: 0 }));
        pg.input(JSON.stringify({ type: "up", x, y, button: 0 }));
        drain();
        a11yDue = true;
      }),
      onFocus: (node) => {
        const m = /^mfd-xd-0-(\d+)$/.exec(node.id || "");
        if (m) { pg.input(JSON.stringify({ type: "focus", target: Number(m[1]) })); a11yDue = true; }
      },
    });
  }
  let tree;
  try { tree = JSON.parse(pg.a11y(pg.eval(FOCUS_ID), ++a11yGen)); } catch (e) { return; }
  mirror.update(tree);
  // (every focusable element takes the focus, so a reader's cursor landing
  // on one focuses it in the page; Tab still goes to the page, which keeps
  // its own order: tabindex values, shadow trees, a modal's inside)
  for (const n of tree.nodes) {
    if (!n.focusable || n.disabled) continue;
    const el = mirror.elementOf(n.id);
    if (el && !el.hasAttribute("tabindex")) el.tabIndex = -1;
  }
  window.__pgA11y = tree;
}
window.__rdA11y = () => { a11yUpdate(true); return window.__pgA11y; };
// between steps the page lives: its timers and animations run
async function idle() {
  for (;;) {
    await frame();
    if (!pg || busy) continue;
    try {
      tick();
      const dirty = pg.dirty();
      if (dirty) draw();
      if (dirty || a11yDue) { a11yUpdate(a11yDue); a11yDue = false; }
      drain();
    } catch (e) {
      errors.push(String(e));
    }
  }
}

$("run").onclick = () => runAll();
$("step").onclick = () => step();
$("reload").onclick = () => open(current.name);
$("all").onclick = () => everyCase();

(async function main() {
  fit();
  if (!gl) setStatus("WebGL 2 is not available: the RangerDOM pane stays empty");
  await document.fonts.ready;
  if (params.get("engine") !== "js") {
    try {
      // (the text measured in the font the painter draws it with: the
      // family DomView gave EVG, ", mfd" its last name, and the weight)
      const mctx = document.createElement("canvas").getContext("2d");
      let mfont = "";
      Engine = await loadWasmPlayground("rangerdom_pg.wasm", {
        measure(family, text, size, bold) {
          const f = fontSpec({ font: family + ", mfd", size, weight: bold ? "bold" : "" }, 1);
          if (f !== mfont) { mctx.font = f; mfont = f; }
          return mctx.measureText(text).width;
        },
      });
      engineName = "WebAssembly";
    } catch (e) {
      console.warn("no WebAssembly engine, using JavaScript:", e);
    }
  }
  if (!Engine) {
    await new Promise((ok, no) => { const sc = document.createElement("script"); sc.src = "rangerdom_pg.js"; sc.onload = ok; sc.onerror = () => no(new Error("no RangerDOM engine (rangerdom_pg.wasm or rangerdom_pg.js)")); document.head.appendChild(sc); });
    mod = globalThis.RangerDomPg;
    Engine = mod.Playground;
    engineName = "JavaScript";
    installCanvasMeasurer(mod);
  }
  $("engine").textContent = engineName;
  cases = await (await fetch("cases/index.json")).json();
  const nav = $("cases");
  for (const c of cases) {
    const b = document.createElement("button");
    b.dataset.name = c.name;
    b.innerHTML = `${c.name}<span class="area"></span>`;
    b.querySelector(".area").textContent = c.area;
    b.onclick = () => { if (!busy) open(c.name); };
    nav.appendChild(b);
  }
  await open(params.get("case") || cases[0].name);
  idle();
  if (params.get("auto")) {
    window.__pgResult = params.get("case") ? await runAll() : await everyCase();
  }
})().catch((e) => {
  setStatus(String(e));
  window.__pgResult = { error: String(e && e.stack || e) };
});
