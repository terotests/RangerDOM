#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// js/*.js -> src/DomScripts.rgr: the realm's scripts as Ranger strings.
//   node tools/gen-scripts.mjs          write it
//   node tools/gen-scripts.mjs --check  fail if it is out of date
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = [
  ["prelude", "js/prelude.js"],
  ["webapi", "js/webapi.js"],
  ["host", "js/host.js"],
];
// a literal holds about 4 KB; the pieces are joined once at run time, so a
// target with immutable strings does not copy the text once per line
const lit = (s) => '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t") + '"';
let out = "; SPDX-License-Identifier: MIT\n";
out += "; GENERATED from js/*.js by tools/gen-scripts.mjs — do not edit.\n\n";
out += "class DomScripts {\n";
for (const [name, file] of SCRIPTS) {
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");
  out += `    sfn ${name}:string () {\n        def p:[string]\n`;
  let chunk = "";
  for (const line of src.split(/(?<=\n)/)) {
    chunk += line;
    if (chunk.length >= 4000) {
      out += "        push p " + lit(chunk) + "\n";
      chunk = "";
    }
  }
  if (chunk.length) out += "        push p " + lit(chunk) + "\n";
  out += '        return (join p "")\n    }\n';
}
out += "}\n";
const dest = path.join(ROOT, "src/DomScripts.rgr");
if (process.argv.includes("--check")) {
  if (!fs.existsSync(dest) || fs.readFileSync(dest, "utf8") !== out) {
    console.error("src/DomScripts.rgr is out of date: run node tools/gen-scripts.mjs");
    process.exit(1);
  }
} else {
  fs.writeFileSync(dest, out);
  console.log("wrote src/DomScripts.rgr");
}
