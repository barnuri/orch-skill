// test-tier: slow (compares with real dispatch.ts active)
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readActive } from "./active-reader";

const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.ts");
const DEAD_PID: number = 2147483646;
const homes: string[] = [];
const procs: Bun.Subprocess[] = [];

// A live process whose command line names the watch, as a real watch's `watch_run <id>` does.
function watchProcess(id: string): number {
  const proc = Bun.spawn(["sh", "-c", "sleep 600; :", "watch_run", id], { stdout: "ignore", stderr: "ignore" });
  procs.push(proc);
  return proc.pid;
}

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "orch-active-"));
  homes.push(home);
  return home;
}

afterAll(() => {
  for (const proc of procs.splice(0)) {
    proc.kill();
  }
  const paths = homes.splice(0);
  if (paths.length > 0) {
    Bun.spawnSync(["trash", ...paths]);
  }
});

function write(home: string, path: string, value: unknown): void {
  const file = join(home, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function loop(home: string, id: string, state: Record<string, unknown>, spec: Record<string, unknown> = {}): void {
  write(home, `loops/${id}/spec.json`, {
    id, kind: "profile", name: "claude-default", interval: 600, max: 5, started: "2026-11-12T10:00:00Z",
    deadline: 4102444800, session_mode: "fresh", session: "", ...spec,
  });
  write(home, `loops/${id}/state.json`, { id, status: "running", iteration: 2, failures: 0, next_tick: 1900000000, last_exit: 0, reason: "", pid: process.pid, ...state });
}

function watch(home: string, id: string, state: Record<string, unknown>): void {
  write(home, `watches/${id}/spec.json`, { id, name: "tail errors", cmd: "tail -f x", interval: 0, started: "2026-11-12T10:00:00Z", deadline: 4102444800 });
  write(home, `watches/${id}/state.json`, { id, status: "running", events: 7, last_event: "2026-11-12T10:05:00Z", reason: "", ...("pid" in state ? {} : { pid: watchProcess(id) }), ...state });
}

function fixture(home: string): void {
  loop(home, "loop-20261112-100000-0001", {});
  loop(home, "loop-20261112-100000-0002", { pid: DEAD_PID });
  loop(home, "loop-20261112-100000-0003", { status: "failed", pid: null, last_exit: 1, reason: "failures" });
  loop(home, "loop-20261112-100000-0004", { status: "stopped", pid: null });
  loop(home, "loop-20261112-100000-0005", { pid: DEAD_PID, demo: true });
  loop(home, "loop-20261112-100000-0006", { skipped: 3 }, { when_idle: true, session_mode: "resume" });
  watch(home, "watch-20261112-100000-0001", {});
  watch(home, "watch-20261112-100000-0002", { pid: DEAD_PID });
  watch(home, "watch-20261112-100000-0003", { status: "stopped", pid: null });
  watch(home, "watch-20261112-100000-0004", { status: "lost", pid: null, reason: "process gone" });
  write(home, "loops/loop-20261112-100000-0007/state.json", { id: "x", status: "running" });
}

async function viaShell(home: string): Promise<unknown[]> {
  const proc = Bun.spawn([process.execPath, DISPATCH, "active", "--json"], {
    env: { ...process.env, HARNESS_ORCH_HOME: home },
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return JSON.parse(text) as unknown[];
}

const byId = (items: readonly { id: string }[]): unknown[] => [...items].sort((a, b) => a.id.localeCompare(b.id));

describe("readActive", () => {
  test("an empty or missing state dir lists nothing", () => {
    expect(readActive(newHome())).toEqual([]);
    expect(readActive("/nonexistent/orch-home")).toEqual([]);
  });

  test("reports a live loop, a lost one, a failed one and leaves stopped ones out", () => {
    const home = newHome();
    fixture(home);
    const items = readActive(home);
    const status = (id: string): string | undefined => items.find((i) => i.id === id)?.status;
    expect(status("loop-20261112-100000-0001")).toBe("running");
    expect(status("loop-20261112-100000-0002")).toBe("lost");
    expect(status("loop-20261112-100000-0003")).toBe("failed");
    expect(status("loop-20261112-100000-0004")).toBeUndefined();
    expect(status("watch-20261112-100000-0001")).toBe("running");
    expect(status("watch-20261112-100000-0002")).toBeUndefined();
    expect(status("watch-20261112-100000-0003")).toBeUndefined();
    expect(status("watch-20261112-100000-0004")).toBe("lost");
  });

  test("a watch whose pid now belongs to another process is not alive", () => {
    const home = newHome();
    watch(home, "watch-20261112-100000-0009", { pid: process.pid });
    expect(readActive(home)).toEqual([]);
  });

  test("a demo loop with no live process is not reported lost", () => {
    const home = newHome();
    fixture(home);
    expect(readActive(home).find((i) => i.id === "loop-20261112-100000-0005")?.status).toBe("running");
  });

  test("a loop with a corrupt or missing spec is skipped, not fatal", () => {
    const home = newHome();
    fixture(home);
    expect(() => readActive(home)).not.toThrow();
    expect(readActive(home).some((i) => i.id === "x")).toBe(false);
  });

  test("matches `dispatch.ts active --json` field for field", async () => {
    const home = newHome();
    fixture(home);
    expect(byId(readActive(home))).toEqual(byId((await viaShell(home)) as { id: string }[]));
  }, 300_000);
});
