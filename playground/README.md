# Playground

A page that runs real UI libraries twice, side by side: in the browser that
opened it, and in RangerDOM. On the RangerDOM side the page's scripts run in
CEr with `js/webapi.js`, its render tree (`__render()`) becomes EVG elements
(`view/`), EVG lays them out, the boxes go back to the page and EVG's display
list is drawn on a WebGL canvas (`evg-webgl.js`). The same steps run in both
(`bench/cases`), each timed, and the page reports whether both sides show the
same thing (the case's probe).

Published on GitHub Pages from `main` (`.github/workflows/playground.yml`).

```
npm install                       # CEr (rgrc install -vendor)
(cd bench && npm ci)              # the libraries under test, esbuild
node playground/build.mjs         # -> playground/dist
npx http-server playground/dist   # or any static server; open /?case=shoelace
node bench/run.mjs                # headless: report + pictures in bench/out
```

| File | Role |
| --- | --- |
| `wasm/` | the engine as a crate (CEr + view/ + json/ + EVG), built to `rangerdom_pg.wasm`: what the page uses by default; `examples/case.rs` runs a built case natively (`cargo run --release --example case -- playground/dist/cases/<name>`, in the staged crate) |
| `native/` | the same engine as a desktop program: an SDL3 window (`src/sdl.rs`, declared by hand), EVG's display list painted by RangerDOM's shared painter (`paint/`, the crate `rangerdom_paint`: boxes, borders, gradients, shadows, clips, group opacity, paths, strokes, SVG and decoded pictures, text with the system's TrueType faces read and rasterized there; a run is stretched to the width EVG measured) and run with SDL's renderer in `src/paint.rs`. The same crate is EVGBrowser's desktop painter, compiled to C++ by Ranger. `node playground/build.mjs --native` builds it (SDL3 found with `pkg-config --static --libs sdl3`), `.github/workflows/native-demo.yml` makes the universal macOS app. `rangerdom-demo [cases dir] [--case NAME]`; the bar above the page changes the case and runs its steps (Ctrl/Cmd+N next step, Ctrl/Cmd+] / [ case, Ctrl/Cmd+R reload); `--steps N --screenshot out.bmp` draws headless |
| `src/Playground.rgr` | the same engine in Ranger, compiled to `rangerdom_pg.js` (`?engine=js`, and the fallback without the WebAssembly build) |
| `build.mjs` | fetches the Ranger compiler and EVG at the commits in `pins.json`, stages the tree view/ and json/ expect, compiles, copies the page and the cases |
| `web/` | the page: `main.js` drives both sides and times them |
| `pins.json` | the Ranger compiler and EVG commits |

Save state / Load state keep the RangerDOM page's whole state in the
page's memory (CEr's heap snapshot: the document, its styles, the page's
scripts and timers; `pg_snapshot` / `pg_restore`) and put it back: what
the host keeps (the laid-out tree) is made again at the first frame. A
load also brings the browser's page to the same step. Natively,
`cargo run --release --example snapcheck -- playground/dist/cases/<name> [step]`
(in the staged crate) runs a case straight through and again with the
page saved after `step` and loaded into a new playground, and fails when
any step's probe differs.

URL parameters: `?case=<name>`, `&auto=1` (run every step at once;
`window.__pgResult` holds the result), `&size=W,H` (default 1200,800),
`&engine=wasm|js`, `&budget=ms` (once a RangerDOM step took longer, the case's later steps run
in the browser only; default 5000, 0 for none).

Timings: the WebAssembly engine is the cargo build of CEr, EVG and the view;
`?engine=js` runs the JavaScript build (several times slower). The
WebAssembly build measures text with EVG's own metrics, the JavaScript one
with the browser's canvas.
