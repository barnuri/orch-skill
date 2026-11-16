// `dispatch.ts doctor`: prints the runtime facts a caller needs to diagnose orch on this host.
// Bun built-ins only. Reads no state files and needs no jq.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function orchHome(): string {
  return process.env.HARNESS_ORCH_HOME || join(homedir(), ".harness-orch");
}

export function doctorLines(): string[] {
  const home = orchHome();
  const herdr = Bun.which("herdr", { PATH: process.env.PATH ?? "" });
  return [
    `bun: ${Bun.version}`,
    "state: read by orch CLI, jq not required",
    `home: ${home}${existsSync(home) ? "" : " (missing, created on first use)"}`,
    `herdr: ${herdr ?? "not found"}`,
  ];
}

export function doctor(): number {
  process.stdout.write(doctorLines().join("\n") + "\n");
  return 0;
}
