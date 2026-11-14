// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export default {
  area: "React components + Tailwind",
  lib: "shadcn/ui (new-york) + Radix + Tailwind 4.3.5",
  about: "shadcn/ui components (Card, Badge, Button, Input, Table, Tabs, Dialog) on Radix primitives and Tailwind v4 (CSS made by the Tailwind CLI: @layer, custom properties, oklch colours, calc, color-mix): filter, row selection via data-state, Radix Dialog open/close (portal, focus), Tabs. Bundled without renamed identifiers: minified, a function named `of` in `for (var e = of(...); ...)` is a SyntaxError in CErXes' parser (pcomp.rs for_statement takes that `of` for for-of).",
  page: (ctx) => {
    const out = path.join(HERE, "out", ".bundles", "shadcn.css");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFileSync(path.join(HERE, "node_modules/.bin/tailwindcss"), ["-i", path.join(HERE, "pages/shadcn.css"), "-o", out, "--minify"], { cwd: path.join(HERE, "pages"), stdio: "pipe" });
    return { css: fs.readFileSync(out, "utf8"), body: '<div id="app"></div>', scripts: [ctx.bundle("shadcn", ctx.file("pages/shadcn.jsx"), { jsx: true, mangle: false })] };
  },
};
