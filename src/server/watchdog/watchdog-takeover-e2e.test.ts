// test-tier: slow (real dispatch.ts processes)
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { WatchdogAction } from "../../shared/types/watchdog";
import { TempHome } from "../test-support/temp-home";
import { actionsLog, TAKEOVER_EVERY_MS, WatchdogService } from "./watchdog-service";

const DISPATCH = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.ts");
const RUN = "e2e-takeover";

// The caller's harness session variables would register the test run's orchestrator, so they are dropped.
function cleanEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(OPENCODE|CLAUDE|HERDR|CODEX|COPILOT|CURSOR|AGENT)/i.test(k)));
}

// The real CLI in the test home. Nothing touches the user's ~/.harness-orch.
function dispatchIn(home: string, args: string[]): { rc: number; out: string } {
  const proc = Bun.spawnSync([process.execPath, DISPATCH, ...args], {
    env: { ...cleanEnv(), HARNESS_ORCH_HOME: home, ORCH_HERDR: "0", ORCH_NO_ANNOUNCE: "1", ORCH_DISPATCH: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { rc: proc.exitCode ?? -1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

function runStatus(home: string): { status: string; nodes: { id: string; status: string }[] } {
  return JSON.parse(readFileSync(join(home, "runs", RUN, "state.json"), "utf8"));
}

test("a run with no orchestrator advances to done under the supervisor", async () => {
  const home = TempHome.create();
  const dir = home.path;
  expect(dispatchIn(dir, ["run", "start", "No orchestrator", "--id", RUN]).rc).toBe(0);
  expect(dispatchIn(dir, ["node", "add", RUN, "write-note", "Write the note"]).rc).toBe(0);
  expect(dispatchIn(dir, ["req", "add", RUN, "Write the note", "--node", "write-note"]).rc).toBe(0);
  expect(dispatchIn(dir, ["run", "set", RUN, "auto_dispatch", "true"]).rc).toBe(0);
  expect(runStatus(dir).status).toBe("running");

  // The worker (not an orchestrator) does its node: start, handoff, result, done. The handoff is written
  // after the attempt starts, or verify counts it as older than the latest attempt.
  const outDir = join(dir, "runs", RUN, "out", "write-note");
  mkdirSync(outDir, { recursive: true });
  expect(dispatchIn(dir, ["node", "update", RUN, "write-note", "running"]).rc).toBe(0);
  writeFileSync(join(outDir, "handoff.md"), "# Handoff\n\nThe note is written.\n");
  expect(dispatchIn(dir, ["node", "result", RUN, "write-note", "--verdict", "full", "--summary", "note written"]).rc).toBe(0);
  expect(dispatchIn(dir, ["node", "update", RUN, "write-note", "done"]).rc).toBe(0);
  expect(dispatchIn(dir, ["req", "evidence", RUN, "R1", "--note", "handoff.md written"]).rc).toBe(0);
  expect(dispatchIn(dir, ["req", "status", RUN, "R1", "handled"]).rc).toBe(0);

  // The supervisor alone: the caller's own terminal may have registered itself, so the registration is removed.
  const stateFile = join(dir, "runs", RUN, "state.json");
  const raw = JSON.parse(readFileSync(stateFile, "utf8"));
  delete raw.coordinator;
  delete raw.harness_session;
  writeFileSync(stateFile, JSON.stringify(raw));
  expect(runStatus(dir).nodes.find((n) => n.id === "write-note")?.status).toBe("done");
  let clock = Date.parse("2026-11-23T10:00:00Z");
  const dog = new WatchdogService(dir, { now: () => new Date(clock), log: () => undefined, health: () => null, pidAlive: () => true });
  for (let pass = 0; pass < 6 && runStatus(dir).status !== "done"; pass++) {
    dog.engine.evaluate(RUN);
    await Promise.all([...dog.inflight, ...dog.engine.inflight]);
    clock += TAKEOVER_EVERY_MS + 1;
  }
  const finalState = runStatus(dir);
  const log = existsSync(actionsLog(dir)) ? readFileSync(actionsLog(dir), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as WatchdogAction) : [];
  expect(finalState.status).toBe("done");
  expect(log.filter((a) => a.rule === "takeover" && a.action === "run advance").length).toBeGreaterThan(0);
  expect(log.filter((a) => a.rule === "takeover" && a.rc !== null && a.rc !== 0).map((a) => a.action)).toEqual([]);
}, 60_000);
