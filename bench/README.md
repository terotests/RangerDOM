# UI library cases

Real UI libraries and synthetic DOM/CSS workloads, each a page with steps
(`cases/<name>.mjs`, `pages/`): the playground runs them in the browser and
in RangerDOM and compares what each shows (`probe()`) and how long each step
takes.

A case is `export default { area, lib, about, page(ctx) }`; `page` returns
`{ css, body, scripts }` and its scripts set `window.__benchCase = { setup(),
steps: [{ name, run() }], probe() }` (`bench-page.js` runs them and reports).
`ctx.nm(path)` reads a file of an npm package, `ctx.file(path)` one of
bench/, `ctx.bundle(name, code, opts)` bundles an entry module with esbuild.

- `build-cases.mjs` writes each case as a page (`--out <dir>`, `--only=a,b`)
- `run.mjs` opens the built playground headless (Playwright) and writes
  `out/report.md`, `out/report.json` and both panes of each case as PNGs

The npm packages here are the test subjects, not part of RangerDOM.
