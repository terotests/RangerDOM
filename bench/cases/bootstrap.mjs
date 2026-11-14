// SPDX-License-Identifier: MIT
export default {
  area: "CSS framework + components",
  lib: "bootstrap 5.3.9",
  about: "Bootstrap 5 page (navbar, list group, accordion, cards in row-cols grid, tabs, table, form with validation, modal) with bootstrap.bundle.js: Popper dropdown, collapse, tab, form :invalid styles, modal open/close with backdrop and transitions.",
  page: (ctx) => ({
    css: ctx.nm("bootstrap/dist/css/bootstrap.min.css"),
    body: ctx.file("pages/bootstrap.html"),
    scripts: [ctx.nm("bootstrap/dist/js/bootstrap.bundle.min.js"), ctx.file("pages/bootstrap.js")],
  }),
};
