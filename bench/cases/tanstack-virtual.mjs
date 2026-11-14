// SPDX-License-Identifier: MIT
export default {
  area: "Virtual list",
  lib: "@tanstack/virtual-core 3.19.11",
  about: "10 000 rows of varying height through TanStack Virtual's framework-free core: measureElement + ResizeObserver, scrollToIndex, rAF scrolling, rows moved with transform. Probe = rows in the DOM, the first one, total size and scrollTop (both /100).",
  page: (ctx) => ({
    css: "body{margin:0;font:14px Arial}#box{position:absolute;left:20px;top:20px;width:700px;height:700px;overflow:auto;border:1px solid #888}#inner{position:relative;width:100%}.r{position:absolute;left:0;top:0;width:100%;box-sizing:border-box;padding:8px 10px;border-bottom:1px solid #eee;white-space:normal}.odd{background:#f6f8fa}",
    body: '<div id="box"><div id="inner"></div></div>',
    scripts: [ctx.bundle("tanstack-virtual", ctx.file("pages/tanstack-virtual.js"))],
  }),
};
