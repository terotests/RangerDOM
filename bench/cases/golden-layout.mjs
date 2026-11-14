// SPDX-License-Identifier: MIT
export default {
  area: "Docking layout",
  lib: "golden-layout 2.6.0",
  about: "Golden Layout 2 docking layout (row / columns / stack of tabs with splitters): add a component, switch a stack's tab, resize the container twice, remove a panel. Probe = tabs, active tabs, panel boxes.",
  page: (ctx) => ({
    css: ctx.nm("golden-layout/dist/css/goldenlayout-base.css") + "\n" + ctx.nm("golden-layout/dist/css/themes/goldenlayout-light-theme.css") +
      "\nbody{margin:0;font-family:Arial}#gl{position:absolute;left:10px;top:10px;width:1100px;height:700px}.pane{padding:8px;font-size:13px}",
    body: '<div id="gl"></div>',
    scripts: [ctx.bundle("golden-layout", ctx.file("pages/golden-layout.js"))],
  }),
};
