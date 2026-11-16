#!/usr/bin/env bun
// Test double: like a real adapter it starts a child agent (here `sleep`) and waits for it.
// Writes the child pid to $FAKE_TREE_PIDS and, when asked, ignores SIGTERM in the child.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const a = process.argv.slice(2);
if (a[0] !== "run") process.exit(2);
writeFileSync(process.env.FAKE_TREE_PROMPT || "/dev/null", readFileSync((a[3] ?? "").replace(/^@/, ""), "utf8"));
const pids = process.env.FAKE_TREE_PIDS ?? "/dev/null";
let child;
if (process.env.FAKE_TREE_STUBBORN) {
  child = Bun.spawn(["bash", "-c", 'trap "" TERM; echo $$ >> "$FAKE_TREE_PIDS"; while :; do sleep 1; done'], { env: process.env as Record<string, string>, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
} else {
  child = Bun.spawn(["sleep", "60"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  appendFileSync(pids, `${child.pid}\n`);
}
console.log("started");
await child.exited;
