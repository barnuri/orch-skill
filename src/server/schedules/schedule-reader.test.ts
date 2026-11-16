// test-tier: slow (real dispatch.sh schedule runs)
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readSchedules } from "./schedule-reader";

const DISPATCH: string = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.sh");
const homes: string[] = [];

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), "orch-sched-"));
  homes.push(home);
  return home;
}

afterAll(() => {
  const paths = homes.splice(0);
  if (paths.length > 0) {
    Bun.spawnSync(["trash", ...paths]);
  }
});

async function sh(home: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["bash", DISPATCH, "schedule", ...args], {
    env: { ...process.env, HARNESS_ORCH_HOME: home },
    stdout: "pipe",
    stderr: "ignore",
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}

async function settle(home: string, id: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const dir = join(home, "schedules", id, "runs");
    const finished = existsSync(dir) && readdirSync(dir).some((run) => existsSync(join(dir, run, "exit")));
    if (finished) {
      return;
    }
    await Bun.sleep(50);
  }
}

describe.concurrent("readSchedules", () => {
  test("a missing or empty state dir lists nothing", async () => {
    expect(readSchedules(newHome())).toEqual([]);
    expect(readSchedules("/nonexistent/orch-home")).toEqual([]);
  });

  test("resolves a finished run before the tick has written it back, and agrees with the shell", async () => {
    const home = newHome();
    const ok = await sh(home, "add", "--name", "good", "--cron", "0 9 * * *", "--command", "echo hi");
    const bad = await sh(home, "add", "--name", "bad", "--cron", "0 10 * * *", "--command", "exit 3");
    await sh(home, "add", "--name", "never", "--cron", "0 11 * * *", "--command", "true");
    await sh(home, "run", ok);
    await sh(home, "run", bad);
    await settle(home, ok);
    await settle(home, bad);

    // The files still say "running": only the shell's reap would change them. The reader must not need it.
    const raw = JSON.parse(await Bun.file(join(home, "schedules", ok, "schedule.json")).text());
    expect(raw.runs[0].status).toBe("running");

    const fromTs = readSchedules(home);
    const byName = (n: string) => fromTs.find((s) => s.name === n);
    expect(byName("good")?.last_status).toBe("ok");
    expect(byName("bad")?.last_status).toBe("failed");
    expect(byName("bad")?.runs[0]?.exit).toBe(3);
    expect(byName("never")?.last_status).toBeNull();

    const fromShell = JSON.parse(await sh(home, "list", "--json")) as typeof fromTs;
    const key = (list: typeof fromTs) =>
      list
        .map((s) => ({ id: s.id, name: s.name, status: s.last_status, runs: s.runs.map((r) => ({ status: r.status, exit: r.exit })) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(key(fromTs)).toEqual(key(fromShell));
  }, 300_000);

  test("schedules made in the same second keep a stable order", async () => {
    const home = newHome();
    for (const name of ["a", "b", "c", "d"]) {
      await sh(home, "add", "--name", name, "--cron", "0 9 * * *", "--command", "true");
    }
    const list = readSchedules(home);
    const expected = [...list].sort((x, y) => y.created_at.localeCompare(x.created_at) || y.id.localeCompare(x.id)).map((s) => s.id);
    expect(list.map((s) => s.id)).toEqual(expected);
    for (let i = 0; i < 5; i += 1) {
      expect(readSchedules(home).map((s) => s.id)).toEqual(expected);
    }
  });

  test("reads, and never writes, the schedule files", async () => {
    const home = newHome();
    const id = await sh(home, "add", "--name", "w", "--cron", "0 9 * * *", "--command", "true");
    await sh(home, "run", id);
    await settle(home, id);
    const file = join(home, "schedules", id, "schedule.json");
    const before = await Bun.file(file).text();
    readSchedules(home);
    expect(await Bun.file(file).text()).toBe(before);
  }, 300_000);

  test("a run whose process vanished without a result is lost", async () => {
    const home = newHome();
    const id = await sh(home, "add", "--name", "gone", "--cron", "0 9 * * *", "--command", "true");
    const file = join(home, "schedules", id, "schedule.json");
    const doc = JSON.parse(await Bun.file(file).text());
    doc.runs = [{ started_at: "2026-11-12T10:00:00Z", ended_at: null, kind: "command", ref: join(home, "no-such-run"), status: "running", exit: null }];
    writeFileSync(file, JSON.stringify(doc));
    expect(readSchedules(home)[0]?.last_status).toBe("lost");
  });

  test("a damaged schedule file is skipped, not fatal", async () => {
    const home = newHome();
    await sh(home, "add", "--name", "fine", "--cron", "0 9 * * *", "--command", "true");
    const bad = await sh(home, "add", "--name", "broken", "--cron", "0 9 * * *", "--command", "true");
    writeFileSync(join(home, "schedules", bad, "schedule.json"), "{ not json");
    expect(readSchedules(home).map((s) => s.name)).toEqual(["fine"]);
  });
});
