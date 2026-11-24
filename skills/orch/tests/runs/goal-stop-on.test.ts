import { test, expect, describe, setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { orch, seedHome, tempHome, editJson, autoCleanup } from "../helpers";
autoCleanup();
setDefaultTimeout(60000);

// `goal` hands --stop-on to `run advance` unchanged (goal.ts advanceArgs), so the stop events are
// checked on `run advance` with a hand-built run, and the goal command itself on parsing and dry-run.
const ENV = { ORCH_HEALTH_MONITOR: "0", ORCH_OWNER_FILL: "0", ORCH_NO_DONE_GATE: "1", ORCH_HERDR: "0", HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: undefined };

/** Run r1: a and b (after a), no stored prompts. `errored` puts a in error, so b waits on a failed node. */
function runHome(errored: boolean) {
  const home = seedHome();
  editJson(join(home, "profiles.json"), (p) => { p.settings.max_attempts = 1; });
  const o = orch(home, ENV);
  o("run", "start", "Stop-on", "--id", "r1");
  o("node", "add", "r1", "a", "A");
  o("node", "add", "r1", "b", "B", "--after", "a");
  if (errored) {
    o("node", "update", "r1", "a", "running", "--owner", "coordinator");
    o("node", "update", "r1", "a", "error", "--error", "boom");
  }
  const advance = (stopOn: string) =>
    o("run", "advance", "r1", "--until-done", "--interval", "1", "--timeout", "2", "--stop-on", stopOn);
  return { home, o, advance };
}

describe.concurrent("goal --dry-run and --stop-on parsing", () => {
  test("dry-run prints the plan and creates no run or state", () => {
    const home = tempHome();
    const r = orch(home, ENV)("goal", "Ship the widget", "--dry-run", "--stop-on", "error", "--interval", "30s", "--timeout", "2m", "--no-finish");
    expect(r.rc).toBe(0);
    expect(r.out).toBe("goal dry-run: Ship the widget\nprofile: default planner\nstop-on: error\ninterval: 30s\ntimeout: 120s\nfinish: no\n");
    expect(existsSync(home)).toBe(false);
  });

  test("dry-run in an existing home adds no run", () => {
    const home = seedHome();
    const before = existsSync(join(home, "runs")) ? readdirSync(join(home, "runs")) : [];
    expect(orch(home, ENV)("goal", "Ship the widget", "--dry-run", "--id", "g1").rc).toBe(0);
    const after = existsSync(join(home, "runs")) ? readdirSync(join(home, "runs")) : [];
    expect(after).toEqual(before);
    expect(existsSync(join(home, "runs/g1"))).toBe(false);
  });

  test("a bad --stop-on value exits 2 on goal and on run advance", () => {
    const home = seedHome(), o = orch(home, ENV);
    const g = o("goal", "Ship the widget", "--stop-on", "never");
    expect(g.rc).toBe(2);
    expect(g.err).toMatch(/--stop-on must be blocked, error, timeout, or all/);
    expect(o("goal", "Ship the widget", "--stop-on").rc).toBe(2);
    expect(existsSync(join(home, "runs")) ? readdirSync(join(home, "runs")).filter((d) => !d.startsWith(".")) : []).toEqual([]);
    o("run", "start", "x", "--id", "r1");
    expect(o("run", "advance", "r1", "--stop-on", "never").rc).toBe(2);
  });

  test("the --stop-on-<event> shorthands set the same value", () => {
    const o = orch(seedHome(), ENV);
    for (const ev of ["blocked", "error", "timeout"]) {
      expect(o("goal", "g", "--dry-run", `--stop-on-${ev}`).out).toMatch(new RegExp(`^stop-on: ${ev}$`, "m"));
    }
  });
});

describe.concurrent("run advance --stop-on events", () => {
  test("blocked: stops with exit 3 when nothing can move", () => {
    const r = runHome(false).advance("blocked");
    expect(r.rc).toBe(3);
    expect(r.out).toMatch(/^blocked: a,b$/m);
  });

  test("all: stops with exit 3 on blocked", () => {
    expect(runHome(false).advance("all").rc).toBe(3);
  });

  test("timeout: keeps waiting while blocked and stops with exit 124 at --timeout", () => {
    const r = runHome(false).advance("timeout");
    expect(r.rc).toBe(124);
    expect(r.err).toMatch(/timed out after 2s/);
  });

  test("error: stops with exit 3 at an errored node and names it", () => {
    const r = runHome(true).advance("error");
    expect(r.rc).toBe(3);
    expect(r.err).toMatch(/stopped on error: a/);
  });

  test("error: does not stop on a blocked run with no errored node", () => {
    const r = runHome(false).advance("error");
    expect(r.rc).toBe(124);
    expect(r.err).not.toMatch(/stopped on error/);
  });

  test("blocked and timeout do not report an error stop", () => {
    const t = runHome(true);
    const b = t.advance("blocked");
    expect(b.rc).toBe(3);
    expect(b.err).not.toMatch(/stopped on error/);
    const to = t.advance("timeout");
    expect(to.rc).toBe(124);
    expect(to.err).not.toMatch(/stopped on error/);
  });
});
