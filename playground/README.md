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
| `src/Playground.rgr` | the engine: DomRealm + DomView + EVG layout + display list, compiled to `rangerdom_pg.js` |
| `build.mjs` | fetches the Ranger compiler and EVG at the commits in `pins.json`, stages the tree view/ and json/ expect, compiles, copies the page and the cases |
| `web/` | the page: `main.js` drives both sides and times them |
| `pins.json` | the Ranger compiler and EVG commits |

URL parameters: `?case=<name>`, `&auto=1` (run every step at once;
`window.__pgResult` holds the result), `&size=W,H` (default 1200,800),
`&budget=ms` (once a RangerDOM step took longer, the case's later steps run
in the browser only; default 5000, 0 for none).

Timings: the RangerDOM side here is the JavaScript build of CEr, EVG and the
view, so its numbers are those of an interpreter compiled to JavaScript, not
of the native or WebAssembly builds.
