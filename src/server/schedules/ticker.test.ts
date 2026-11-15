import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CATCHUP_GRACE_MS, detachedSpawn, evaluateSchedules } from "./ticker";

const homes: string[] = [];
function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "orch-ticker-"));
  homes.push(home);
  return home;
}
afterAll(() => {
  for (const h of homes) {
    rmSync(h, { recursive: true, force: true });
  }
});

function writeSchedule(home: string, id: string, patch: Record<string, unknown>): void {
  const dir = join(home, "schedules", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "schedule.json"), JSON.stringify({ id, enabled: true, next_at: null, runs: [], ...patch }));
}

function recorder(): { calls: string[]; spawn: (args: string[]) => void } {
  const calls: string[] = [];
  return { calls, spawn: (args) => void calls.push(args.join(" ")) };
}

const T = 1_800_000_000;
const AT = T * 1000 + 5_000;

describe("evaluateSchedules", () => {
  test("a due schedule is claimed before the spawn and spawned once", () => {
    const home = makeHome();
    writeSchedule(home, "s1", { next_at: T });
    const r = recorder();
    evaluateSchedules(home, AT, r.spawn);
    expect(existsSync(join(home, "schedules", "s1", "claims", String(T)))).toBe(true);
    expect(r.calls).toEqual(["schedule tick"]);
    evaluateSchedules(home, AT + 1000, r.spawn);
    expect(r.calls).toEqual(["schedule tick"]);
  });

  test("a restart (new evaluation over the same state) does not run twice", () => {
    const home = makeHome();
    writeSchedule(home, "s1", { next_at: T });
    const before = recorder();
    evaluateSchedules(home, AT, before.spawn);
    const after = recorder();
    evaluateSchedules(home, AT + 2000, after.spawn);
    expect(before.calls.length + after.calls.length).toBe(1);
  });

  test("a not-yet-due or disabled schedule is left alone", () => {
    const home = makeHome();
    writeSchedule(home, "later", { next_at: T + 3600 });
    writeSchedule(home, "off", { next_at: T, enabled: false });
    const r = recorder();
    evaluateSchedules(home, AT, r.spawn);
    expect(r.calls).toEqual([]);
  });

  test("a fire lost in a restart is caught up once, after the grace period", () => {
    const home = makeHome();
    writeSchedule(home, "s1", { next_at: T });
    evaluateSchedules(home, AT, recorder().spawn);
    // the tick died: next_at moved on, no run was recorded
    writeSchedule(home, "s1", { next_at: T + 3600 });
    const r = recorder();
    evaluateSchedules(home, AT + 10_000, r.spawn);
    expect(r.calls).toEqual([]);
    evaluateSchedules(home, AT + CATCHUP_GRACE_MS + 1000, r.spawn);
    expect(r.calls).toEqual(["schedule run s1"]);
    evaluateSchedules(home, AT + CATCHUP_GRACE_MS + 31_000, r.spawn);
    expect(r.calls).toEqual(["schedule run s1"]);
  });

  test("no catch-up when the run was created, or one is still running", () => {
    const home = makeHome();
    writeSchedule(home, "ran", { next_at: T });
    writeSchedule(home, "busy", { next_at: T });
    evaluateSchedules(home, AT, recorder().spawn);
    const started = new Date(AT + 3000).toISOString();
    writeSchedule(home, "ran", { next_at: T + 3600, runs: [{ started_at: started, status: "ok" }] });
    writeSchedule(home, "busy", { next_at: T + 3600, runs: [{ started_at: "2020-01-01T00:00:00Z", status: "running" }] });
    const r = recorder();
    evaluateSchedules(home, AT + CATCHUP_GRACE_MS + 1000, r.spawn);
    expect(r.calls).toEqual([]);
  });

  test("at most one catch-up per schedule even with several lost fires", () => {
    const home = makeHome();
    writeSchedule(home, "s1", { next_at: T });
    evaluateSchedules(home, AT, recorder().spawn);
    writeSchedule(home, "s1", { next_at: T + 60 });
    evaluateSchedules(home, AT + 60_000, recorder().spawn);
    writeSchedule(home, "s1", { next_at: T + 7200 });
    const r = recorder();
    evaluateSchedules(home, AT + 3 * CATCHUP_GRACE_MS, r.spawn);
    expect(r.calls).toEqual(["schedule run s1"]);
  });
});

describe("detachedSpawn", () => {
  test("runs dispatch in its own session through ORCH_DISPATCH", async () => {
    const home = makeHome();
    const fake = join(home, "fake-dispatch.sh");
    const out = join(home, "out.txt");
    writeFileSync(fake, `#!/bin/bash\nps -o pid=,pgid=,sess= -p $$ > "${out}"\necho "$$ $PPID $*" >> "${out}"\n`);
    const prev = process.env["ORCH_DISPATCH"];
    process.env["ORCH_DISPATCH"] = fake;
    try {
      detachedSpawn(["schedule", "tick"], home);
    } finally {
      if (prev === undefined) {
        delete process.env["ORCH_DISPATCH"];
      } else {
        process.env["ORCH_DISPATCH"] = prev;
      }
    }
    for (let i = 0; i < 100 && !existsSync(out); i++) {
      await Bun.sleep(100);
    }
    await Bun.sleep(300);
    const [ps, line] = readFileSync(out, "utf8").trim().split("\n");
    const [pid, pgid] = (ps ?? "").trim().split(/\s+/).map(Number);
    expect(pgid).toBe(pid);
    expect(pgid).not.toBe(process.pid);
    expect(line).toContain("schedule tick");
  });
});
