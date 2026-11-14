// SPDX-License-Identifier: MIT
export default {
  area: "Animation (transform)",
  about: "500 absolutely placed boxes, transform (translate + rotate) set every rAF for 30 frames, twice, then 30 frames of opacity (synthetic test 5). Frame time = step total / 30.",
  page: (ctx) => ({
    css: "body{margin:0;font:12px Arial}#app{position:relative;width:1180px;height:780px;overflow:hidden}.b{position:absolute;width:40px;height:30px;background:#5b8def;color:#fff;border-radius:4px;text-align:center;line-height:30px}",
    body: '<div id="app"></div>',
    scripts: [ctx.file("pages/animation.js")],
  }),
};
