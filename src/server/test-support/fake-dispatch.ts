#!/usr/bin/env bun
// Stand-in for dispatch.ts in route-wiring tests (ORCH_DISPATCH). Prints the JSON shape of the real
// `harness list --json` without probing any binary. `enabled` follows settings.disabled_harnesses.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

const a = process.argv.slice(2);
const home = process.env.HARNESS_ORCH_HOME ?? "";
const record = (file: string, line: string) => appendFileSync(`${home}/${file}`, line + "\n");
const compact = (f: string) => readFileSync(f, "utf8").replace(/[ \n]/g, "");

if (a[0] === "harness" && a[1] === "list") {
  const profiles = `${home}/profiles.json`;
  const text = existsSync(profiles) ? compact(profiles) : "";
  const entries = ["claude", "cursor-agent", "opencode", "local-llm", "copilot", "pi"].map((id) => {
    const enabled = !new RegExp(`"disabled_harnesses":\\[[^\\]]*"${id}"`).test(text);
    return `{"id":"${id}","kind":"cli","binary":"${id}","wired":true,"description":"fake ${id}","needs":[],"available":true,"reason":"","enabled":${enabled}}`;
  });
  console.log(`{"probed_at":"2026-01-01T00:00:00Z","harnesses":[${entries.join(",")}]}`);
  process.exit(0);
}
if (a[0] === "run" && a[1] === "messages" && a[3] === "retry") {
  record("fake-dispatch.sweeps", a.join(" "));
  process.exit(0);
}
if ((a[0] === "node" && (a[1] === "update" || a[1] === "started")) || (a[0] === "run" && a[1] === "finish")) {
  record("fake-dispatch.actions", a.join(" "));
  process.exit(0);
}
if ((a[0] === "run" || a[0] === "node") && a[1] === "retry") {
  if (process.env.ORCH_EVENT_BY) record("fake-dispatch.actions", a.join(" "));
  const state = `${home}/runs/${a[2] ?? ""}/state.json`;
  if (!existsSync(state)) {
    console.error(`${a[0]} retry: run ${a[2] ?? ""} not found`);
    process.exit(1);
  }
  if (!/"status":"(error|skipped)"/.test(compact(state)) && !(a.includes("--early-end") && /"status":"done"/.test(compact(state)))) {
    console.error(`node retry: ${a[3] ?? "run"} is not error or skipped`);
    process.exit(2);
  }
  console.log(`retried ${a[3] ?? a[2] ?? ""}`);
  process.exit(0);
}
if (a[0] === "node" && a[1] === "dispatch") {
  record("fake-dispatch.calls", `${a[2] ?? ""} ${a[3] ?? ""} ${a[5] ?? ""}`);
  console.log(`job-fake-${a[3] ?? ""}`);
  process.exit(0);
}
if (a[0] === "node" && a[1] === "bind-owners") {
  record("fake-dispatch.owners", a.join(" "));
  process.exit(0);
}
console.error(`fake-dispatch: unsupported: ${a.join(" ")}`);
process.exit(2);
