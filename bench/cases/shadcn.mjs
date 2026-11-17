// SPDX-License-Identifier: MIT
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export default {
  area: "React components + Tailwind",
  lib: "shadcn/ui (new-york v4) + radix-ui 1.8 + cmdk, react-day-picker, sonner, vaul, input-otp, lucide + Tailwind 4.3.5, tw-animate-css",
  about: "Most shadcn/ui components, one card each: Button, Badge, Kbd, Card, Input, Label, Alert, Accordion, Tabs, Checkbox, Switch, Radio group, Select, Slider, Progress, Toggle, Toggle group, Separator, Avatar, Skeleton, Dialog, Alert dialog, Sheet, Drawer (vaul), Popover, Tooltip, Hover card, Dropdown menu (checkbox, radio, submenu), Menubar, Context menu, Command (cmdk), Combobox, Calendar (react-day-picker), Collapsible, Scroll area, Navigation menu, Breadcrumb, Pagination, Textarea, Input OTP, Sonner toast, Table. Steps are input as a person gives it (pointer presses, hovers, keys, typing dispatched to the elements), so Radix's pointerdown triggers, dismissable layers, focus scopes, roving focus and presence (exit animations end on animationend) run in both engines. Tailwind v4 CSS (@layer, custom properties, oklch, calc, color-mix) with tw-animate-css enter/exit keyframes.",
  page: (ctx) => {
    const out = path.join(HERE, "out", ".bundles", "shadcn.css");
    fs.mkdirSync(path.dirname(out), { recursive: true });
    execFileSync(path.join(HERE, "node_modules/.bin/tailwindcss"), ["-i", path.join(HERE, "pages/shadcn.css"), "-o", out, "--minify"], { cwd: path.join(HERE, "pages"), stdio: "pipe" });
    return { css: fs.readFileSync(out, "utf8"), body: '<div id="app"></div>', scripts: [ctx.bundle("shadcn", ctx.file("pages/shadcn.jsx"), { jsx: true })] };
  },
};
