#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// The UI library cases (cases/*.mjs) as pages the playground loads:
//
//   node bench/build-cases.mjs [--out <dir>] [--only=a,b]
//
// writes <dir>/<case>/index.html, bench-page.js, s0.js ... and
// <dir>/index.json ([{name, area, lib, about, scripts, css}]). A case is
// export default { area, lib, about, page(ctx) -> { css, body, bodyAttrs,
// scripts: [js text], assets: {file: text} } }; its scripts run after
// bench-page.js, which gives them window.__bench (setup, steps, probe).
// Needs `npm ci` in bench/ (the libraries under test and esbuild).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NM = path.join(HERE, "node_modules");
const argv = process.argv.slice(2);
const outAt = argv.indexOf("--out");
const OUT = outAt >= 0 ? path.resolve(argv[outAt + 1]) : path.join(HERE, "out", "cases");
const onlyArg = argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.slice(7).split(",") : null;
if (!fs.existsSync(path.join(NM, ".bin", "esbuild"))) {
  console.error("bench/node_modules is missing: run npm ci in bench/");
  process.exit(1);
}

const ctx = {
  nm: (p) => fs.readFileSync(path.join(NM, p), "utf8"),
  file: (p) => fs.readFileSync(path.join(HERE, p), "utf8"),
  // an entry module bundled into one IIFE script (esbuild, a test tool: the
  // bundle is the test subject)
  bundle(name, code, { jsx = false, define = {}, jsxImport = "", mangle = true } = {}) {
    const dir = path.join(HERE, "out", ".bundles");
    fs.mkdirSync(dir, { recursive: true });
    const entry = path.join(dir, name + (jsx ? ".jsx" : ".js"));
    fs.writeFileSync(entry, code);
    const outFile = path.join(dir, name + ".bundle.js");
    const args = [entry, "--bundle", "--format=iife", ...(mangle ? ["--minify"] : ["--minify-whitespace", "--minify-syntax"]), "--target=es2020", `--outfile=${outFile}`, "--log-level=error",
      "--define:process.env.NODE_ENV=\"production\"", "--loader:.css=empty", "--jsx=automatic"];
    for (const [k, v] of Object.entries(define)) args.push(`--define:${k}=${v}`);
    if (jsxImport) args.push(`--jsx-import-source=${jsxImport}`);
    execFileSync(path.join(NM, ".bin", "esbuild"), args, { cwd: HERE, env: { ...process.env, NODE_PATH: NM } });
    return fs.readFileSync(outFile, "utf8");
  },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
function pageHtml(name, p) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(name)}</title>
<style>${(p.css || "").replace(/<\/style/gi, "<\\/style")}</style>
</head><body${p.bodyAttrs ? " " + p.bodyAttrs : ""}>
${p.body || ""}
<script src="bench-page.js"></script>
${(p.scripts || []).map((_, i) => `<script src="s${i}.js"></script>`).join("\n")}
</body></html>
`;
}

const names = fs.readdirSync(path.join(HERE, "cases")).filter((f) => f.endsWith(".mjs")).map((f) => f.slice(0, -4)).sort()
  .filter((n) => !only || only.includes(n));
fs.mkdirSync(OUT, { recursive: true });
const index = [];
for (const name of names) {
  const c = (await import(pathToFileURL(path.join(HERE, "cases", name + ".mjs")).href)).default;
  const t0 = Date.now();
  let p;
  try {
    p = c.page(ctx);
  } catch (e) {
    console.error(`  ${name}: ${String(e.message || e).split("\n")[0]}`);
    continue;
  }
  const dir = path.join(OUT, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), pageHtml(name, p));
  fs.writeFileSync(path.join(dir, "bench-page.js"), ctx.file("bench-page.js"));
  (p.scripts || []).forEach((s, i) => fs.writeFileSync(path.join(dir, `s${i}.js`), s));
  for (const [k, v] of Object.entries(p.assets || {})) fs.writeFileSync(path.join(dir, k), v);
  index.push({ name, area: c.area || "", lib: c.lib || "", about: c.about || "", scripts: (p.scripts || []).length });
  console.log(`  ${name} (${Date.now() - t0} ms)`);
}
fs.writeFileSync(path.join(OUT, "index.json"), JSON.stringify(index, null, 1) + "\n");
console.log(`${index.length} cases -> ${path.relative(process.cwd(), OUT) || "."}`);
