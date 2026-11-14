// SPDX-License-Identifier: MIT
export default {
  area: "DOM create/remove",
  about: "createElement/appendChild/textContent of 1 000 and 10 000 rows, removeChild, innerHTML (synthetic test 1).",
  page: (ctx) => ({
    css: "body{margin:0;font:14px Arial}#app{height:780px;overflow:hidden}.row{display:flex;gap:8px;padding:2px 6px;border-bottom:1px solid #eee}.odd{background:#f7f7f9}.id{width:60px;color:#666}.label{flex:1}.del{color:#c00;text-decoration:none}",
    body: '<div id="app"></div>',
    scripts: [ctx.file("pages/dom-create.js")],
  }),
};
