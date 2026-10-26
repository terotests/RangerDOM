#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Build tests/RealmTest.rgr and run it.
//   node tools/test.mjs          JavaScript (Node)
//   node tools/test.mjs --cpp    C++ (g++ or clang++)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RGRC = process.env.RANGER_DIR
  ? path.resolve(process.env.RANGER_DIR, "dist", "rgrc.js")
  : path.join(ROOT, "node_modules", "ranger-compiler", "dist", "rgrc.js");
if (!fs.existsSync(RGRC)) { console.error("run npm install first"); process.exit(1); }
const cpp = process.argv.includes("--cpp");

execFileSync(process.execPath, [path.join(ROOT, "tools/gen-scripts.mjs"), "--check"], { stdio: "inherit" });

function compile(args) {
  let log = "";
  try {
    log = execFileSync(process.execPath, ["--stack-size=8000", RGRC, ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    log = String(e.stdout || "") + String(e.stderr || "");
  }
  if (log.includes("Compilation FAILED") || log.includes("[FAIL]")) {
    process.stderr.write(log.split("\n").filter((l) => !l.includes("api docs")).join("\n") + "\n");
    process.exit(1);
  }
}

function run(cmd, args) {
  const out = execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8" });
  process.stdout.write(out);
  if (!/failed 0\s*$/.test(out)) process.exit(1);
}

fs.mkdirSync(path.join(ROOT, "build"), { recursive: true });
if (cpp) {
  compile(["-l=cpp", "tests/RealmTest.rgr", "-d=build/cpp", "-o=realm_test.cpp"]);
  const cxx = ["g++", "clang++"].find((c) => { try { execFileSync(c, ["--version"], { stdio: "ignore" }); return true; } catch (_) { return false; } });
  if (!cxx) { console.error("no C++ compiler found"); process.exit(1); }
  execFileSync(cxx, ["-std=c++17", "-O2", "-w", "build/cpp/realm_test.cpp", "-o", "build/cpp/realm_test"], { cwd: ROOT, stdio: "inherit" });
  run(path.join(ROOT, "build/cpp/realm_test"), [ROOT]);
} else {
  compile(["-es6", "tests/RealmTest.rgr", "-d=build", "-o=realm_test.cjs", "-nodecli"]);
  run(process.execPath, [path.join(ROOT, "build/realm_test.cjs"), ROOT]);
}
