#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// The playground, headless: every case (or --only=a,b) opened in Chromium
// (Playwright) with ?auto=1, its steps run in the browser and in RangerDOM,
// the result written as JSON and Markdown, and both panes as pictures with
// the share of pixels that differ.
//
//   node bench/run.mjs [--site=playground/dist] [--only=a,b] [--out=bench/out]
//                      [--budget=ms: the playground's ?budget]
//                      [--units=0: scripts compiled in the page, not read from the build's units]
//
// Needs a built playground (node playground/build.mjs) and Playwright.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const opts = { site: path.join(ROOT, "playground", "dist"), only: "", out: path.join(HERE, "out"), budget: "", units: "" };
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--(site|only|out|budget|units)=(.*)$/);
  if (!m) throw new Error("unknown argument " + a);
  opts[m[1]] = m[2];
}
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const SITE = path.resolve(opts.site);
const OUT = path.resolve(opts.out);
fs.mkdirSync(OUT, { recursive: true });

const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".wasm": "application/wasm" };
const server = http.createServer((req, res) => {
  const p = path.join(SITE, decodeURIComponent(new URL(req.url, "http://x").pathname));
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, "index.html") : p;
  if (!file.startsWith(SITE) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const base = `http://127.0.0.1:${server.address().port}/`;

const all = JSON.parse(fs.readFileSync(path.join(SITE, "cases", "index.json"), "utf8")).map((c) => c.name);
const names = opts.only ? opts.only.split(",") : all;
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const results = [];
for (const name of names) {
  const page = await browser.newPage({ viewport: { width: 2600, height: 1400 } });
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  const t0 = Date.now();
  await page.goto(`${base}?case=${encodeURIComponent(name)}&auto=1${opts.budget ? "&budget=" + opts.budget : ""}${opts.units ? "&units=" + opts.units : ""}`);
  let r;
  try {
    await page.waitForFunction(() => window.__pgResult, null, { timeout: 180000, polling: 250 });
    r = await page.evaluate(() => window.__pgResult);
  } catch (e) {
    r = { case: name, error: "timed out" };
  }
  // the two panes, the same size, and how many pixels differ
  await page.locator("#nativeBox").screenshot({ path: path.join(OUT, `${name}-browser.png`), timeout: 120000 });
  await page.locator("#rdBox").screenshot({ path: path.join(OUT, `${name}-rangerdom.png`), timeout: 120000 });
  const pct = await page.evaluate(async ([a, b]) => {
    const load = (u) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = u; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);
    const px = (img) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); x.drawImage(img, 0, 0); return x.getImageData(0, 0, w, h).data; };
    const da = px(ia), db = px(ib);
    let n = 0;
    for (let i = 0; i < da.length; i += 4) if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 48) n++;
    return (100 * n) / (w * h);
  }, [`data:image/png;base64,${fs.readFileSync(path.join(OUT, `${name}-browser.png`)).toString("base64")}`, `data:image/png;base64,${fs.readFileSync(path.join(OUT, `${name}-rangerdom.png`)).toString("base64")}`]);
  r.pixelDiff = pct;
  r.pageErrors = pageErrors;
  r.wall = Date.now() - t0;
  results.push(r);
  const rows = r.rows || [];
  console.log(`${name}: ${rows.filter((x) => x.same).length}/${rows.filter((x) => !x.skipped).length} same${rows.some((x) => x.skipped) ? ` (${rows.filter((x) => x.skipped).length} skipped)` : ""}, pixels differ ${pct.toFixed(1)} %, ${r.errors ? r.errors.length : 0} errors${r.error ? " (" + r.error + ")" : ""}`);
  await page.close();
}
await browser.close();
server.close();

fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(results, null, 1) + "\n");
const f = (v) => (typeof v === "number" ? (v < 10 ? v.toFixed(1) : String(Math.round(v))) : "–");
let md = "# RangerDOM vs the browser\n\n| Case | Step | Browser until drawn | RangerDOM until drawn | render | layout | display list | Same |\n|---|---|---:|---:|---:|---:|---:|:-:|\n";
for (const r of results) {
  for (const x of r.rows || []) md += `| ${r.case} | ${x.name} | ${f(x.native.drawn)} | ${f(x.rd.drawn)} | ${f(x.rd.render)} | ${f(x.rd.layout)} | ${f(x.rd.paint)} | ${x.skipped ? "skipped" : x.same ? "yes" : "no"} |\n`;
}
md += "\n| Case | Pixels differ % | Errors |\n|---|---:|---|\n";
for (const r of results) md += `| ${r.case} | ${f(r.pixelDiff)} | ${(r.errors || []).concat(r.pageErrors || []).slice(0, 3).join("; ").replace(/\|/g, "\\|").slice(0, 300)} |\n`;
fs.writeFileSync(path.join(OUT, "report.md"), md);
console.log(`Wrote ${path.relative(process.cwd(), path.join(OUT, "report.md"))}`);
