// SPDX-License-Identifier: MIT
//
// The playground page: a case (bench/cases) in this browser (an iframe) and
// in RangerDOM (rangerdom_pg.js: the page's scripts in CEr with webapi.js,
// its render tree laid out by EVG, the display list drawn by evg-webgl.js),
// the same steps in both, timed.
//
//   ?case=<name>     open that case
//   &auto=1          run its steps at once; window.__pgResult has the result
//   &size=W,H        the page's viewport (default 1200,800)
//   &budget=ms       once a step took longer than this in RangerDOM, the
//                    case's later steps run in the browser only (default
//                    5000; 0 runs every step). The JavaScript build of CEr
//                    is slow, and a 10 000-row step can exhaust the tab.
import { renderDisplayList } from "./evg-webgl.js";
import { installCanvasMeasurer } from "./evg-measure.js";

const params = new URLSearchParams(location.search);
const [W, H] = (params.get("size") || "1200,800").split(",").map(Number);
const BUDGET = params.has("budget") ? Number(params.get("budget")) : 5000;
const DPR = Math.min(2, window.devicePixelRatio || 1);
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const frame = () => new Promise((ok) => requestAnimationFrame(() => ok()));
const fmt = (v) => (v === null || v === undefined || Number.isNaN(v) ? "–" : v < 10 ? v.toFixed(1) : Math.round(v).toString());

const mod = globalThis.RangerDomPg;
const canvas = $("rd");
const iframe = $("native");
canvas.width = Math.round(W * DPR);
canvas.height = Math.round(H * DPR);
canvas.style.width = W + "px";
canvas.style.height = H + "px";
iframe.style.width = W + "px";
iframe.style.height = H + "px";
const gl = canvas.getContext("webgl2", { antialias: true, premultipliedAlpha: false, stencil: true, preserveDrawingBuffer: true });

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
    if (pg.dirty()) draw();
    drain();
    if (done()) break;
    if (performance.now() > end) { errors.push(`timed out after ${ms} ms`); break; }
    const due = pg.dueIn();
    if (due === 0) await sleep(0); else await frame();
  }
  for (let k = 0; k < 8; k++) {
    pg.tick(0);
    if (!pg.dirty()) break;
    draw();
  }
  drain();
}
function realmValue(src) { return pg.eval(src); }
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
  pg = new mod.Playground();
  pg.reset();
  for (const src of [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])) {
    pg.addScript(new URL(src, base).href, await (await fetch(base + src)).text());
  }
  errors = [];
  resetAcc();
  const t0 = performance.now();
  pg.start(html, base + "index.html", W, H);
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

// ------------------------------------------------------------- a case
let cases = [];
let current = null;
let state = null; // { steps: [names], next, rows: [] }

function row(r) {
  const tr = document.createElement("tr");
  const same = JSON.stringify(r.nativeProbe) === JSON.stringify(r.rdProbe);
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
  if (!same) td.title = "browser: " + JSON.stringify(r.nativeProbe) + "\nRangerDOM: " + JSON.stringify(r.rdProbe);
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
  installCanvasMeasurer(mod);
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
