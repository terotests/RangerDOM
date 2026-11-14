// SPDX-License-Identifier: MIT
export default {
  area: "CSS layout (flex/grid)",
  about: "150 cards (~2 000 boxes): auto-fill grid, flex rows and wrapping chips; container width, flex-wrap, direction, font-size and fixed grid changes (synthetic test 3). Probe = boxes of the first/last card and a chip.",
  page: (ctx) => ({
    css: "body{margin:0;font:13px Arial}#app{width:1180px;padding:10px;display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px}" +
      "#app.flex{display:flex;flex-wrap:wrap}#app.flex .card{width:260px}#app.grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}" +
      ".card{display:flex;flex-direction:column;border:1px solid #ccd;border-radius:6px;padding:8px;gap:6px;background:#fff}" +
      ".head{display:flex;align-items:center;gap:6px}.colhead .head{flex-direction:column;align-items:flex-start}.dot{width:10px;height:10px;border-radius:50%;background:#48c}.grow{flex:1}" +
      ".chips{display:flex;flex-wrap:wrap;gap:4px}.chip{padding:1px 6px;border-radius:9px;background:#eef}.foot{display:flex;align-items:center}button{font:inherit;padding:2px 8px}",
    body: '<div id="app"></div>',
    scripts: [ctx.file("pages/layout-flexgrid.js")],
  }),
};
