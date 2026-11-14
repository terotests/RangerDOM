// SPDX-License-Identifier: MIT
import { jsfbPage } from "../jsfb-page.mjs";
export default {
  area: "js-framework-benchmark",
  lib: "preact",
  about: "js-framework-benchmark's operations (create/replace 1 000 rows, partial update, select, swap, remove, create 10 000, append 1 000, clear) in the keyed preact implementation, on Bootstrap 5's style sheet.",
  page: (ctx) => jsfbPage(ctx, [ctx.bundle("jsfb-preact", ctx.file("pages/jsfb/preact.jsx"), { jsx: true, jsxImport: "preact" })]),
};
