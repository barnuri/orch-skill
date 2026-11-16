#!/usr/bin/env bun
// Optional static gates. Each tool SKIPs when absent (oxfmt/oxlint are only used if already in bun's cache or on PATH:
// nothing is downloaded here). Only real errors fail (exit 1): oxlint errors. Formatting never fails;
// it only prints how many files differ from .oxfmtrc.json.
import { REPO_DIR, run, which } from "./lib/util.ts";

let rc = 0;
const tool = (name: string, ...args: string[]) => {
  if (which(name)) return run([name, ...args], { cwd: REPO_DIR });
  if (which("bunx")) return run(["bunx", "--no-install", name, ...args], { cwd: REPO_DIR });
  return { code: 127, out: "", err: "" };
};
const count = (text: string, needle: string): number => text.split("\n").filter((l) => l.includes(needle)).length;

if (tool("oxfmt", "--version").code === 0) {
  const r = tool("oxfmt", "--check", "src");
  const n = (r.out + r.err).split("\n").filter((l) => /\.(ts|tsx|css|json) \(/.test(l)).length;
  console.log(`format: ${n} file(s) differ from .oxfmtrc.json (not enforced)`);
} else console.log("SKIP: oxfmt not available");

if (tool("oxlint", "--version").code === 0) {
  const r = tool("oxlint", "src");
  const o = r.out + r.err;
  const errs = count(o, ": error ");
  console.log(`oxlint: ${errs} error(s), ${count(o, ": warning ")} warning(s)`);
  if (errs > 0) {
    console.log(o.split("\n").filter((l) => l.includes(": error ")).slice(0, 20).join("\n"));
    rc = 1;
  }
} else console.log("SKIP: oxlint not available");

process.exit(rc);
