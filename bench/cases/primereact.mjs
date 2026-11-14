// SPDX-License-Identifier: MIT
const noFonts = (css) => css.replace(/@font-face\s*{[^}]*}/g, "");
export default {
  area: "React component library",
  lib: "primereact 10.9.9 (Lara light blue)",
  about: "PrimeReact 10 with its Lara theme: DataTable (200 rows, paging 10, sort, global filter, selection), Dropdown overlay (portal + positioning), Dialog with mask, Tag, ProgressBar. @font-face rules are left out on both sides (same faces).",
  page: (ctx) => ({
    css: noFonts(ctx.nm("primereact/resources/themes/lara-light-blue/theme.css") + "\n" + ctx.nm("primereact/resources/primereact.min.css")) +
      "\nbody{margin:0;font-family:Arial}.flex-bar{display:flex;gap:8px;margin-bottom:8px}.w-12rem{width:12rem}",
    body: '<div id="app"></div>',
    scripts: [ctx.bundle("primereact", ctx.file("pages/primereact.jsx"), { jsx: true })],
  }),
};
