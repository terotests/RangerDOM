// SPDX-License-Identifier: MIT
export default {
  area: "Scrolling",
  about: "3 000 rows in an overflow:auto box: scrollTop jumps, 20 rAF frames of scrolling, scrollIntoView (synthetic test 4). Probe = scrollTop, scrollHeight and the row under the middle (elementFromPoint).",
  page: (ctx) => ({
    css: "body{margin:0;font:14px Arial}#box{position:absolute;left:20px;top:20px;width:600px;height:700px;overflow:auto;border:1px solid #999}.r{height:24px;line-height:24px;padding:0 8px;border-bottom:1px solid #eee;white-space:nowrap}.r:nth-child(odd){background:#f6f8fa}",
    body: '<div id="box"></div>',
    scripts: [ctx.file("pages/scroll.js")],
  }),
};
