#!/usr/bin/env bun
// Integration lane: seeds a temp orch home, bind-mounts it into the compose stack on a random port,
// runs the Playwright integration specs, proves the live home is unchanged, and tears the stack down.
// Usage: bun tools/ui-lanes/integration/run.ts [--keep]
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLanePort, fingerprint, freePort, seedLaneHome } from "./lib.ts";

const here = import.meta.dir;
const laneRoot = join(here, "..");
const compose = join(here, "docker-compose.yml");
const keep = process.argv.includes("--keep");

const port = assertLanePort(process.env["ORCH_LANE_PORT"] ? Number(process.env["ORCH_LANE_PORT"]) : await freePort());

const root = mkdtempSync(join(tmpdir(), "orch-lane-"));
const home = join(root, "orch-home");
const sandboxHome = join(root, "home");
const project = `orch-lane-${port}`;
// The lane runs with HOME=sandboxHome. A sentinel orch-named folder under it must survive the run unchanged:
// any write that resolved HOME to the user's real home would change the sentinel fingerprint.
const sentinel = join(sandboxHome, ".harness-orch");
const env = { ...process.env, ORCH_LANE_PORT: String(port), ORCH_LANE_HOME: home, COMPOSE_PROJECT_NAME: project };

const docker = (args: string[]): number =>
  spawnSync("docker", ["compose", "-p", project, "-f", compose, ...args], { env, stdio: "inherit" }).status ?? 1;

let code = 1;
try {
  mkdirSync(home, { recursive: true });
  mkdirSync(sentinel, { recursive: true });
  writeFileSync(join(sentinel, "sentinel.txt"), "must not change\n");
  const sentinelBefore = fingerprint(sentinel);
  await seedLaneHome(home, sandboxHome);
  if (docker(["up", "-d", "--build", "--wait"]) !== 0) throw new Error("compose up failed");

  const url = `http://127.0.0.1:${port}`;
  const play = spawnSync("npx", ["playwright", "test", "-c", "playwright.integration.config.ts"], {
    cwd: laneRoot,
    env: { ...env, ORCH_LANE_URL: url },
    stdio: "inherit",
  });
  if (play.status !== 0) throw new Error("integration Playwright specs failed");

  if (fingerprint(sentinel) !== sentinelBefore) throw new Error("lane wrote under the sentinel home (fingerprint changed)");
  console.log(`integration lane: ok (port ${port}, sentinel home unchanged)`);
  code = 0;
} catch (e) {
  console.error(String(e));
} finally {
  if (!keep) {
    docker(["down", "-v"]);
    rmSync(root, { recursive: true, force: true });
  } else {
    console.log(`kept stack ${project} on port ${port}, lane home ${home}`);
  }
}
process.exit(code);
