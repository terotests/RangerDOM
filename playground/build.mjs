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
//   node playground/build.mjs --no-wasm    # without rangerdom_pg.wasm
//   node playground/build.mjs --native     # also the desktop program (SDL3),
//                                          # -> <out>/native/rangerdom-demo
//   node playground/build.mjs --native-lib # the program as a static library
//                                          # per target, linked elsewhere
//                                          # (playground/native/mac-link.sh)
//
// The engine bundle (rangerdom_pg.js) is playground/src/Playground.rgr
// compiled to JavaScript in a staged tree, because view/ and json/ reach EVG
// as ../../../lib/evg, as they do in a Ranger checkout. The compiler and EVG
// are the commits playground/pins.json names, fetched into .deps/ (RANGER_DIR
// and EVG_DIR name checkouts of your own instead: a Ranger tree, and an evg
// tree whose storm/ is EVG). The cases are bench/build-cases.mjs's.
//
// rangerdom_pg.wasm, the engine the page uses by default, is playground/wasm
// (the same engine written as a crate) built with cargo for wasm32-wasip1 in
// the Ranger tree, where its crates' relative paths lead: lib/evg,
// gallery/domview, gallery/domjson and gallery/domstyle (view/, json/,
// style/), gallery/cer (CEr) and
// gallery/rangerdom_pg (playground/wasm with js/). Needs cargo and
// `rustup target add wasm32-wasip1`; without them the page falls back to the
// JavaScript engine.
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
const withWasm = !argv.includes("--no-wasm");
const withNativeLib = argv.includes("--native-lib");
const withNative = argv.includes("--native") || withNativeLib;
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

// (the compiler finds gallery/<name> in the Ranger tree before the staged
// one: the WebAssembly build below stages view/ and json/ there, and a copy
// left by an earlier build was compiled instead of view/. So they are put
// there now, as they are, with the EVG their imports name: ../../../lib/evg)
for (const [from, to] of [[EVG, "lib/evg"], [path.join(ROOT, "view"), "gallery/domview"], [path.join(ROOT, "json"), "gallery/domjson"]]) {
  fs.rmSync(path.join(RANGER, to), { recursive: true, force: true });
  fs.cpSync(from, path.join(RANGER, to), { recursive: true, filter: (p) => !p.includes(`${path.sep}target`) });
}
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
// (the compiler writes the encoder as `new TextEncoder()`, or since Ranger
// 64458b4 as an object that makes one on first use: either is replaced)
let ENC = "const r_cb_enc = new TextEncoder();";
if (!code.includes(ENC)) {
  const at = code.indexOf("const r_cb_enc = { e: null, encode: function (s) {");
  const end = at < 0 ? -1 : code.indexOf("\n} };\n", at);
  ENC = end < 0 ? "" : code.slice(at, end + 5);
}
if (!ENC) throw new Error("rangerdom_pg.js: no r_cb_enc to patch (the compiler changed: check the load time)");
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
for (const f of ["evg-webgl.js", "evg-measure.js", "evg-a11y.js"]) fs.copyFileSync(path.join(EVG, "gl", f), path.join(OUT, f));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

const G = path.join(RANGER, "gallery");
const place = (from, to) => {
  fs.rmSync(path.join(RANGER, to), { recursive: true, force: true });
  fs.cpSync(from, path.join(RANGER, to), { recursive: true, filter: (p) => !p.includes(`${path.sep}target`) });
};
// the engine crate and what it reaches, in the Ranger tree
function placeEngine() {
  place(EVG, "lib/evg");
  place(path.join(ROOT, "view"), "gallery/domview");
  place(path.join(ROOT, "json"), "gallery/domjson");
  place(path.join(ROOT, "style"), "gallery/domstyle");
  place(path.join(ROOT, "vendor", "ranger", "cer"), "gallery/cer");
  fs.mkdirSync(path.join(G, "rangerdom_pg"), { recursive: true });
  for (const f of ["Cargo.toml", "src"]) place(path.join(HERE, "wasm", f), `gallery/rangerdom_pg/${f}`);
  place(path.join(ROOT, "js"), "gallery/rangerdom_pg/js");
}

if (withWasm) {
  placeEngine();
  console.log("==> rangerdom_pg.wasm (cargo, wasm32-wasip1)");
  const crate = path.join(G, "rangerdom_pg");
  try {
    execFileSync("cargo", ["build", "--release", "--lib", "--target", "wasm32-wasip1"], {
      cwd: crate, stdio: ["ignore", "inherit", "inherit"],
      // deep pages lay out deep: the module's one stack is 32 MB
      env: { ...process.env, RUSTFLAGS: "-C link-arg=-zstack-size=33554432" },
    });
    fs.copyFileSync(path.join(crate, "target", "wasm32-wasip1", "release", "rangerdom_pg.wasm"), path.join(OUT, "rangerdom_pg.wasm"));
  } catch (e) {
    console.error("rangerdom_pg.wasm was not built (cargo with the wasm32-wasip1 target?): the page will use rangerdom_pg.js");
    if (process.env.CI) process.exit(1);
  }
}

// The desktop program: playground/native (an SDL3 window that draws EVG's
// display list) beside the engine crate, built for the host or for
// NATIVE_TARGETS (comma separated cargo targets; more than one on macOS are
// joined into one universal binary with lipo). SDL3 is linked as
// `pkg-config --static --libs sdl3` (or SDL3_LIBS) says.
if (withNative) {
  placeEngine();
  for (const f of ["Cargo.toml", "src"]) place(path.join(ROOT, "paint", f), `gallery/rangerdom_paint/${f}`);
  for (const f of ["Cargo.toml", "build.rs", "src"]) place(path.join(HERE, "native", f), `gallery/rangerdom_native/${f}`);
  // (the engine as a Rust library only: a cdylib would need the target's
  // linker, which a static library built off a Mac does not have)
  const pgToml = path.join(G, "rangerdom_pg", "Cargo.toml");
  fs.writeFileSync(pgToml, fs.readFileSync(pgToml, "utf8").replace('crate-type = ["cdylib", "rlib"]', 'crate-type = ["rlib"]'));
  const crate = path.join(G, "rangerdom_native");
  const targets = (process.env.NATIVE_TARGETS || "").split(",").filter(Boolean);
  const dir = path.join(OUT, "native");
  fs.mkdirSync(dir, { recursive: true });
  const bins = [];
  if (withNativeLib) for (const t of targets.length ? targets : [""]) {
    console.log(`==> librangerdom_native.a (cargo${t ? ", " + t : ""})`);
    execFileSync("cargo", ["rustc", "--release", "--lib", "--crate-type", "staticlib", ...(t ? ["--target", t] : [])], { cwd: crate, stdio: ["ignore", "inherit", "inherit"] });
    fs.copyFileSync(path.join(crate, "target", t, "release", "librangerdom_native.a"), path.join(dir, `librangerdom_native${t ? "-" + t : ""}.a`));
  }
  else for (const t of targets.length ? targets : [""]) {
    console.log(`==> rangerdom-demo (cargo${t ? ", " + t : ""})`);
    execFileSync("cargo", ["build", "--release", ...(t ? ["--target", t] : [])], { cwd: crate, stdio: ["ignore", "inherit", "inherit"] });
    bins.push(path.join(crate, "target", t, "release", "rangerdom-demo"));
  }
  if (!withNativeLib) {
    if (bins.length > 1) execFileSync("lipo", ["-create", "-output", path.join(dir, "rangerdom-demo"), ...bins], { stdio: "inherit" });
    else fs.copyFileSync(bins[0], path.join(dir, "rangerdom-demo"));
    fs.chmodSync(path.join(dir, "rangerdom-demo"), 0o755);
  }
}

if (withCases) {
  execFileSync(process.execPath, [path.join(ROOT, "bench", "build-cases.mjs"), "--out", path.join(OUT, "cases")], { stdio: "inherit" });
}
// CEr's code cache: js/ and each case's script files compiled once here by
// the module itself (pg_compile), so that a page reads the compiled unit and
// does not parse and compile (rangerdom_pg.units.json, <script>.unit).
const WASM = path.join(OUT, "rangerdom_pg.wasm");
if (withWasm && fs.existsSync(WASM)) {
  console.log("==> compiled units");
  let memory = null;
  const wasi = {
    clock_time_get(_i, _p, out) { new DataView(memory.buffer).setBigUint64(out, BigInt(Date.now()) * 1000000n, true); return 0; },
    random_get(ptr, len) { new Uint8Array(memory.buffer, ptr, len).fill(7); return 0; },
    environ_sizes_get(c, z) { const v = new DataView(memory.buffer); v.setUint32(c, 0, true); v.setUint32(z, 0, true); return 0; },
    environ_get() { return 0; },
    fd_write(_fd, iovs, n, written) {
      const v = new DataView(memory.buffer);
      let total = 0;
      for (let i = 0; i < n; i++) total += v.getUint32(iovs + i * 8 + 4, true);
      v.setUint32(written, total, true);
      return 0;
    },
    proc_exit(code) { throw new Error("rangerdom wasm exited (" + code + ")"); },
  };
  const { instance } = await WebAssembly.instantiate(fs.readFileSync(WASM), {
    wasi_snapshot_preview1: wasi,
    // (only compiles here: nothing is laid out, nothing measured)
    rangerdom: { pg_measure() { return 0; } },
  });
  const x = instance.exports;
  memory = x.memory;
  if (x._initialize) x._initialize();
  const compile = (src) => {
    const b = Buffer.from(src, "utf8");
    const p = x.pg_alloc(b.length);
    new Uint8Array(memory.buffer, p, b.length).set(b);
    const n = x.pg_compile(p, b.length);
    return n ? Buffer.from(new Uint8Array(memory.buffer, x.pg_out_ptr(), n)).toString("utf8") : "";
  };
  const core = {};
  for (const f of ["prelude.js", "webapi.js", "host.js"]) core[`rangerdom:${f}`] = compile(`rangerdom:${f}`);
  fs.writeFileSync(path.join(OUT, "rangerdom_pg.units.json"), JSON.stringify(core));
  const casesDir = path.join(OUT, "cases");
  let count = 0, bytes = 0;
  if (fs.existsSync(casesDir)) {
    for (const name of fs.readdirSync(casesDir)) {
      const page = path.join(casesDir, name, "index.html");
      if (!fs.existsSync(page)) continue;
      for (const m of fs.readFileSync(page, "utf8").matchAll(/<script src="([^"]+)"/g)) {
        const file = path.join(casesDir, name, m[1]);
        if (!fs.existsSync(file)) continue;
        const unit = compile(fs.readFileSync(file, "utf8"));
        if (unit) { fs.writeFileSync(file + ".unit", unit); count++; bytes += unit.length; }
      }
    }
  }
  console.log(`${count} script units, ${(bytes / 1048576).toFixed(1)} MB`);
}
console.log(`Wrote ${path.relative(process.cwd(), OUT) || "."}`);
