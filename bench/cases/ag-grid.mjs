// SPDX-License-Identifier: MIT
export default {
  area: "Data grid",
  lib: "ag-grid-community 36.3.0",
  about: "AG Grid Community, 2 000 x 8 with the Quartz theme (styles injected by the grid), row/column virtualisation: sort, ensureIndexVisible(1000), quick filter, selection, column resize, clear.",
  page: (ctx) => ({
    css: "body{margin:0;font-family:Arial}#grid{position:absolute;left:10px;top:10px;width:1100px;height:700px}",
    body: '<div id="grid"></div>',
    scripts: [ctx.bundle("ag-grid", ctx.file("pages/ag-grid.js"))],
  }),
};
