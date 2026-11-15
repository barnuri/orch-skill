import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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

afterEach(() => {
  for (const home of homes.splice(0)) {
    Bun.spawnSync(["trash", home]);
  }
});

function sh(home: string, ...args: string[]): string {
  const proc = Bun.spawnSync(["bash", DISPATCH, "schedule", ...args], { env: { ...process.env, HARNESS_ORCH_HOME: home } });
  return new TextDecoder().decode(proc.stdout).trim();
}

async function settle(home: string, id: string): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const dir = join(home, "schedules", id, "runs");
    const runs = Bun.spawnSync(["bash", "-c", `ls "${dir}"/*/exit 2>/dev/null | wc -l`]);
    if (Number(new TextDecoder().decode(runs.stdout).trim()) > 0) {
      return;
    }
    await Bun.sleep(250);
  }
}

describe("readSchedules", () => {
  test("a missing or empty state dir lists nothing", () => {
    expect(readSchedules(newHome())).toEqual([]);
    expect(readSchedules("/nonexistent/orch-home")).toEqual([]);
  });

  test("resolves a finished run before the tick has written it back, and agrees with the shell", async () => {
    const home = newHome();
    const ok = sh(home, "add", "--name", "good", "--cron", "0 9 * * *", "--command", "echo hi");
    const bad = sh(home, "add", "--name", "bad", "--cron", "0 10 * * *", "--command", "exit 3");
    sh(home, "add", "--name", "never", "--cron", "0 11 * * *", "--command", "true");
    sh(home, "run", ok);
    sh(home, "run", bad);
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

    const fromShell = JSON.parse(sh(home, "list", "--json")) as typeof fromTs;
    const key = (list: typeof fromTs) =>
      list
        .map((s) => ({ id: s.id, name: s.name, status: s.last_status, runs: s.runs.map((r) => ({ status: r.status, exit: r.exit })) }))
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(key(fromTs)).toEqual(key(fromShell));
  }, 60000);

  test("schedules made in the same second keep a stable order", () => {
    const home = newHome();
    for (const name of ["a", "b", "c", "d"]) {
      sh(home, "add", "--name", name, "--cron", "0 9 * * *", "--command", "true");
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
    const id = sh(home, "add", "--name", "w", "--cron", "0 9 * * *", "--command", "true");
    sh(home, "run", id);
    await settle(home, id);
    const file = join(home, "schedules", id, "schedule.json");
    const before = await Bun.file(file).text();
    readSchedules(home);
    expect(await Bun.file(file).text()).toBe(before);
  }, 60000);

  test("a run whose process vanished without a result is lost", () => {
    const home = newHome();
    const id = sh(home, "add", "--name", "gone", "--cron", "0 9 * * *", "--command", "true");
    const file = join(home, "schedules", id, "schedule.json");
    const doc = JSON.parse(Bun.spawnSync(["cat", file]).stdout.toString());
    doc.runs = [{ started_at: "2026-11-12T10:00:00Z", ended_at: null, kind: "command", ref: join(home, "no-such-run"), status: "running", exit: null }];
    writeFileSync(file, JSON.stringify(doc));
    expect(readSchedules(home)[0]?.last_status).toBe("lost");
  });

  test("a damaged schedule file is skipped, not fatal", () => {
    const home = newHome();
    sh(home, "add", "--name", "fine", "--cron", "0 9 * * *", "--command", "true");
    const bad = sh(home, "add", "--name", "broken", "--cron", "0 9 * * *", "--command", "true");
    writeFileSync(join(home, "schedules", bad, "schedule.json"), "{ not json");
    expect(readSchedules(home).map((s) => s.name)).toEqual(["fine"]);
  });
});
