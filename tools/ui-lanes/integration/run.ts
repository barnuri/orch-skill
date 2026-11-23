#!/usr/bin/env bun
// Integration lane: builds the compose stack, seeds a run through the in-container CLI, probes the API, tears down.
// Usage: bun tools/ui-lanes/integration/run.ts [--keep]
import { fileURLToPath } from "node:url";

const compose = fileURLToPath(new URL("./docker-compose.yml", import.meta.url));
const port = process.env["ORCH_LANE_PORT"] ?? "16724";
if (port === "6724") throw new Error("refusing to use the live service port 6724");
const sh = (args: string[]) => Bun.spawnSync(["docker", "compose", "-f", compose, ...args], { stdout: "inherit", stderr: "inherit" }).exitCode;

let code = 1;
try {
  if (sh(["up", "-d", "--build", "--wait"]) !== 0) throw new Error("compose up failed");
  sh(["exec", "-T", "orch", "bun", "skills/orch/scripts/dispatch.ts", "run", "start", "Lane run", "--id", "lane-run"]);
  let ok = false;
  for (let i = 0; i < 30 && !ok; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/runs`);
      ok = res.ok && (await res.text()).includes("lane-run");
    } catch {}
    if (!ok) await Bun.sleep(1000);
  }
  if (!ok) throw new Error("API did not list the seeded run");
  console.log("integration lane: ok");
  code = 0;
} catch (e) {
  console.error(String(e));
} finally {
  if (!process.argv.includes("--keep")) sh(["down", "-v"]);
}
process.exit(code);
