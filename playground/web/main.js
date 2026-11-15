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
import { renderDisplayList } from "./evg-webgl.js";
import { installCanvasMeasurer } from "./evg-measure.js";
import { loadWasmPlayground } from "./rangerdom-wasm.js";

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
const acc = { render: 0, layout: 0, paint: 0, gl: 0, frames: 0 };
function resetAcc() { acc.render = acc.layout = acc.paint = acc.gl = acc.frames = 0; }

// the page as it is now: render tree, EVG layout (boxes back), display list, WebGL
function draw() {
  let t = performance.now();
  pg.render();
  let t2 = performance.now();
  acc.render += t2 - t;
  pg.layout();
  t = performance.now();
  acc.layout += t - t2;
  const list = JSON.parse(pg.paint());
  t2 = performance.now();
  acc.paint += t2 - t;
  if (gl) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderDisplayList(gl, { width: W, height: H, list }, { dpr: DPR });
  }
  acc.gl += performance.now() - t2;
  acc.frames++;
}
function drain() {
  let msgs = [];
  try { msgs = JSON.parse(pg.messages() || "[]"); } catch (_) {}
  for (const m of msgs) {
    if (m.tag === "error") errors.push(m.text);
    else if (m.tag === "console" && m.level === "error") errors.push(m.text);
    else if (m.tag === "console" && m.text.startsWith("[bench] ")) {
      try { const o = JSON.parse(m.text.slice(8)); if (o.error) errors.push(o.error); } catch (_) {}
    }
  }
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
  let line = null;
  try { line = await call(w.__bench); } catch (e) { line = { error: String(e) }; }
  await new Promise((ok) => w.requestAnimationFrame(() => w.requestAnimationFrame(() => ok())));
  const drawn = performance.now() - t0;
  let probe = null;
  try { probe = w.__benchCase && w.__benchCase.probe ? JSON.parse(JSON.stringify(w.__benchCase.probe())) : null; } catch (e) { probe = { probeError: String(e) }; }
  return { line, drawn, probe };
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
function textRuns(w, max) {
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
      out.push([q.left, q.top, q.width, q.height]);
      if (out.length >= max) break;
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
  try { runs = textRuns(w, 400); } catch (_) {}
  let blank = 0, firstBlank = null;
  for (const [x, y, rw, rh] of runs) {
    // ink: a pixel that differs from the run's corner (its background)
    const bg = at(x + 0.5, y + 0.5);
    let ink = false;
    for (let yy = y + 1; yy < y + rh - 1 && !ink; yy += 1 / DPR) {
      for (let xx = x + 1; xx < x + rw - 1; xx += 1 / DPR) {
        const c = at(xx, yy);
        if (Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 90) { ink = true; break; }
      }
    }
    if (!ink) { blank++; if (!firstBlank) firstBlank = [x, y, rw, rh].map(Math.round); }
  }
  unhide.remove();
  // a few points or runs off is a font's edge or a frame of an animation
  const ok = off <= Math.max(2, points * 0.03) && blank <= Math.max(1, runs.length * 0.05);
  return { ok, points, off, worst, runs: runs.length, blank, firstBlank };
}
function pictureText(p) {
  if (!p) return "";
  let t = `picture: ${p.off}/${p.points} flat points differ, ${p.blank}/${p.runs} text runs blank in RangerDOM`;
  if (p.worst) t += `\nworst point (${p.worst.x}, ${p.worst.y}): browser rgb(${p.worst.browser}), RangerDOM rgb(${p.worst.rangerdom})`;
  if (p.firstBlank) t += `\nfirst blank run at (${p.firstBlank[0]}, ${p.firstBlank[1]}) ${p.firstBlank[2]}×${p.firstBlank[3]}`;
  return t;
}

// ------------------------------------------------------------- a case
let cases = [];
let current = null;
let state = null; // { steps: [names], next, rows: [] }

function row(r) {
  const tr = document.createElement("tr");
  const sameProbe = JSON.stringify(r.nativeProbe) === JSON.stringify(r.rdProbe);
  const same = sameProbe && (!r.picture || r.picture.ok);
  r.same = same;
  const cells = [r.name, fmt(r.native.js), fmt(r.native.drawn), fmt(r.rd.js), fmt(r.rd.render), fmt(r.rd.layout), fmt(r.rd.paint), fmt(r.rd.gl), fmt(r.rd.drawn)];
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
    r = { name: state.steps[k], native: { js: native.line && native.line.total, drawn: native.drawn }, rd: {}, nativeProbe: native.probe, rdProbe: undefined, skipped: true };
  } else {
    resetAcc();
    const t0 = performance.now();
    const line = await rdRun(`__bench.run(${k})`, 20000);
    const drawn = performance.now() - t0;
    r = { name: state.steps[k], native: { js: native.line && native.line.total, drawn: native.drawn }, rd: { js: line && line.total, render: acc.render, layout: acc.layout, paint: acc.paint, gl: acc.gl, drawn }, nativeProbe: native.probe, rdProbe: rdProbe() };
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
    out.push({ name: c.name, steps: r.rows.filter((x) => !x.skipped).length, skipped: r.rows.filter((x) => x.skipped).length, same: r.rows.filter((x) => x.same).length, native: sum((x) => x.native.drawn), rd: sum((x) => x.rd.drawn), errors: r.errors.length });
  }
  const div = $("summary");
  div.hidden = false;
  div.innerHTML = "<h3>Every case</h3><table><thead><tr><th>Case</th><th>Same result</th><th>Browser, until drawn (ms)</th><th>RangerDOM, until drawn (ms)</th><th>Errors</th></tr></thead><tbody>" +
    out.map((o) => `<tr><td>${o.name}</td><td>${o.same}/${o.steps}${o.skipped ? ` (${o.skipped} skipped)` : ""}</td><td>${fmt(o.native)}</td><td>${fmt(o.rd)}</td><td>${o.errors}</td></tr>`).join("") + "</tbody></table>";
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
    pg.input(JSON.stringify({ type, x: p.x, y: p.y }));
  });
}
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
for (const [evName, type] of [["keydown", "key"], ["keyup", "keyup"]]) {
  canvas.addEventListener(evName, (ev) => {
    if (!pg || busy) return;
    if (ev.key === "Tab" || ev.key.startsWith("Arrow") || ev.key === " " || ev.key === "Backspace") ev.preventDefault();
    pg.input(JSON.stringify({ type, key: ev.key, code: ev.code, shift: ev.shiftKey, ctrl: ev.ctrlKey, alt: ev.altKey, meta: ev.metaKey }));
  });
}
// between steps the page lives: its timers and animations run
async function idle() {
  for (;;) {
    await frame();
    if (!pg || busy) continue;
    try {
      tick();
      if (pg.dirty()) draw();
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
      Engine = await loadWasmPlayground("rangerdom_pg.wasm");
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
