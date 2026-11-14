#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// Build the playground: a page that runs each UI library case of bench/ in
// the browser itself and in RangerDOM (CEr + webapi.js, laid out by EVG,
// drawn with WebGL), side by side, with timings.
//
//   node playground/build.mjs              # -> playground/dist/
//   node playground/build.mjs --out site   # somewhere else (the Pages build)
//   node playground/build.mjs --no-cases   # the engine and the page only
//
// The engine bundle (rangerdom_pg.js) is playground/src/Playground.rgr
// compiled to JavaScript in a staged tree, because view/ and json/ reach EVG
// as ../../../lib/evg, as they do in a Ranger checkout. The compiler and EVG
// are the commits playground/pins.json names, fetched into .deps/ (RANGER_DIR
// and EVG_DIR name checkouts of your own instead: a Ranger tree, and an evg
// tree whose storm/ is EVG). The cases are bench/build-cases.mjs's.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
const OUT = outAt >= 0 ? path.resolve(argv[outAt + 1]) : path.join(HERE, "dist");
const withCases = !argv.includes("--no-cases");
const pins = JSON.parse(fs.readFileSync(path.join(HERE, "pins.json"), "utf8"));

// <dir> at <rev> of <git>, only the <sparse> paths
function fetchPinned(name, pin, dir) {
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  if (fs.existsSync(path.join(dir, ".git"))) {
    let head = "";
    try { head = git("rev-parse", "HEAD"); } catch (_) {}
    if (head === pin.rev) return;
  } else {
    fs.mkdirSync(dir, { recursive: true });
    git("init", "-q");
    git("remote", "add", "origin", pin.git);
  }
  console.log(`==> ${name} ${pin.rev.slice(0, 7)} (${path.relative(ROOT, dir)})`);
  if (pin.sparse) {
    git("sparse-checkout", "init", "--no-cone");
    git("sparse-checkout", "set", "--no-cone", ...pin.sparse.map((p) => "/" + p + "/"));
  }
  git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", pin.rev);
  git("checkout", "-q", "-f", "--detach", "FETCH_HEAD");
}

const RANGER = process.env.RANGER_DIR ? path.resolve(process.env.RANGER_DIR) : path.join(ROOT, ".deps", "ranger");
if (!process.env.RANGER_DIR) {
  fetchPinned("Ranger", pins.ranger, RANGER);
  // dist/rgrc.js is CommonJS; this repository's package.json says "module"
  fs.writeFileSync(path.join(RANGER, "package.json"), '{ "type": "commonjs" }\n');
}
const EVG = process.env.EVG_DIR ? path.resolve(process.env.EVG_DIR, "storm") : path.join(ROOT, ".deps", "evg", "storm");
if (!process.env.EVG_DIR) fetchPinned("EVG", pins.evg, path.dirname(EVG));
const RGRC = path.join(RANGER, "dist", "rgrc.js");
if (!fs.existsSync(RGRC)) throw new Error(`no Ranger compiler at ${RGRC}`);
if (!fs.existsSync(path.join(EVG, "EVGElement.rgr"))) throw new Error(`no EVG at ${EVG}`);
if (!fs.existsSync(path.join(ROOT, "vendor", "ranger", "cer"))) throw new Error("no vendor/ranger/cer: run npm install (rgrc install -vendor)");

// the staged tree
const STAGE = path.join(ROOT, "build", "pg-stage");
fs.rmSync(STAGE, { recursive: true, force: true });
const put = (from, to) => fs.cpSync(from, path.join(STAGE, to), { recursive: true, filter: (p) => !p.includes(`${path.sep}target`) });
put(path.join(ROOT, "src"), "src");
put(path.join(ROOT, "view"), "gallery/domview");
put(path.join(ROOT, "json"), "gallery/domjson");
put(path.join(HERE, "src"), "playground/src");
put(EVG, "lib/evg");
put(path.join(ROOT, "ranger.json"), "ranger.json");
put(path.join(ROOT, "ranger.lock"), "ranger.lock");
fs.symlinkSync(path.join(ROOT, "vendor"), path.join(STAGE, "vendor"));

console.log("==> rangerdom_pg.js (Ranger -> JavaScript)");
let log = "";
try {
  log = execFileSync(process.execPath, ["--stack-size=8000", RGRC, "-es6", "playground/src/Playground.rgr", "-d=out", "-o=rangerdom_pg.js", "-nodecli"],
    { cwd: STAGE, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
} catch (e) {
  log = String(e.stdout || "") + String(e.stderr || "");
}
if (log.includes("Compilation FAILED") || log.includes("[FAIL]")) {
  process.stderr.write(log.split("\n").filter((l) => !l.includes("api docs")).join("\n") + "\n");
  process.exit(1);
}
let code = fs.readFileSync(path.join(STAGE, "out", "rangerdom_pg.js"), "utf8").replace(/^#![^\n]*\n/, "");
// Ranger's JavaScript for a Rust `s.as_bytes()[i]` encodes the whole string
// again on each read, so CEr's lexer is quadratic in the source: webapi.js
// took 10 s to load. Until the compiler keeps the bytes, the encoder keeps
// its last sixteen long answers and the short ones (CEr's punctuators) (strings do not change; the answers are only read).
const ENC = "const r_cb_enc = new TextEncoder();";
if (!code.includes(ENC)) throw new Error("rangerdom_pg.js: no r_cb_enc to patch (the compiler changed: check the load time)");
code = code.replace(ENC, `const r_cb_enc = (function () {
  const te = new TextEncoder();
  const kept = new Map();
  const small = new Map();
  return {
    encode(s) {
      if (s.length <= 4) {
        let w = small.get(s);
        if (w === undefined) {
          w = te.encode(s);
          if (small.size < 4096) small.set(s, w);
        }
        return w;
      }
      if (s.length < 256) return te.encode(s);
      let v = kept.get(s);
      if (v === undefined) {
        v = te.encode(s);
        if (kept.size >= 16) kept.delete(kept.keys().next().value);
        kept.set(s, v);
      }
      return v;
    },
    encodeInto(s, d) { return te.encodeInto(s, d); },
  };
})();`);
const exportsJs = "{ Playground: Playground, EVGHostTextMeasurer: EVGHostTextMeasurer, EVGDefaultMeasurer: EVGDefaultMeasurer }";
// loads without Node's require, and has its exports
{
  const prev = globalThis.require;
  globalThis.require = undefined;
  const found = (0, eval)(`(function(){${code}\n;return typeof Playground + '|' + typeof EVGHostTextMeasurer + '|' + typeof EVGDefaultMeasurer;})()`);
  globalThis.require = prev;
  if (found !== "function|function|function") throw new Error(`rangerdom_pg.js is missing its exports (${found})`);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "rangerdom_pg.js"),
  `// GENERATED from playground/src/Playground.rgr by playground/build.mjs - do not edit.\n(function () {\n${code}\n;globalThis.RangerDomPg = ${exportsJs};\n})();\n`);

for (const f of fs.readdirSync(path.join(HERE, "web"))) fs.cpSync(path.join(HERE, "web", f), path.join(OUT, f), { recursive: true });
for (const f of ["evg-webgl.js", "evg-measure.js"]) fs.copyFileSync(path.join(EVG, "gl", f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

if (withCases) {
  execFileSync(process.execPath, [path.join(ROOT, "bench", "build-cases.mjs"), "--out", path.join(OUT, "cases")], { stdio: "inherit" });
}
console.log(`Wrote ${path.relative(process.cwd(), OUT) || "."}`);
