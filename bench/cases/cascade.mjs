// SPDX-License-Identifier: MIT
export default {
  area: "CSS cascade / style recalc",
  about: "5 000 nodes, ~200 rules (descendant, child, attribute, :nth-child, :not, :is) and one subject :has() rule as in Monaco's CSS: class at the root, class/attribute deep inside, input type flip that changes :has(), 20 deep changes on a :has page, a new rule (synthetic test 6).",
  page: (ctx) => ({
    css: "body{margin:0;font:12px Arial}#app{columns:4;padding:6px}ul{margin:0;padding-left:14px}",
    body: '<div id="app"></div>',
    scripts: [ctx.file("pages/cascade.js")],
  }),
};
