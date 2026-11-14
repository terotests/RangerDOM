// SPDX-License-Identifier: MIT
export default {
  area: "DOM mutation",
  about: "1 000 rows: every text and class changed, every 10th row, swap, remove, reverse, classList.toggle, inline style (synthetic test 2).",
  page: (ctx) => ({
    css: "body{margin:0;font:14px Arial}#app{height:780px;overflow:hidden}.row{display:flex;gap:8px;padding:2px 6px;border-bottom:1px solid #eee}.id{width:50px;color:#666}.label{flex:1}.tag{color:#fff;background:#3a7;padding:0 4px;border-radius:3px}.hot{background:#fee}.cold{background:#eef}.sel{font-weight:bold}",
    body: '<div id="app"></div>',
    scripts: [ctx.file("pages/dom-mutate.js")],
  }),
};
