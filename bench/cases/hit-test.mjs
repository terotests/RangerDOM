// SPDX-License-Identifier: MIT
export default {
  area: "Hit testing",
  about: "60 overlapping boxes with z-index, overflow:hidden clipping of a bigger child, rotate(), pointer-events:none; elementFromPoint on 1 000 points before and after moving a third of them (synthetic test 7).",
  page: (ctx) => ({
    css: "body{margin:0;font:12px Arial}#app{position:relative;width:1180px;height:780px}.b{position:absolute;width:120px;height:90px;background:rgba(80,120,200,.5);border:1px solid #235}" +
      ".rot{transform:rotate(30deg)}.clip{overflow:hidden;background:rgba(200,120,80,.5)}.inner{position:absolute;left:60px;top:40px;width:200px;height:200px;background:rgba(0,150,0,.5)}.none{pointer-events:none;background:rgba(0,0,0,.2)}",
    body: '<div id="app"></div>',
    scripts: [ctx.file("pages/hit-test.js")],
  }),
};
