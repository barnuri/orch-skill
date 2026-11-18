import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyRunner, confirmMiss, effectiveDeadline, homeFromEnv, isTempHome, judgeAll, killGhosts, ownUidLines, parseRunnerLines, RUNNER_RE, selfCheckReason,
  type Facts, type RunnerProc,
} from "./ghosts.ts";

const NOW = 1_800_000_000;
const TMP = "/var/folders/x/T";
const HOME = "/Users/me/.harness-orch";
const TEMP_HOME = `${TMP}/orch-t-abc`;

const proc = (over: Partial<RunnerProc> = {}): RunnerProc => ({ pid: 4242, kind: "loop", id: "loop-1", home: HOME, command: "bun dispatch.ts loop __run loop-1", ...over });
const live = (over: Partial<NonNullable<Facts["record"]>> = {}) => ({ status: "running", pid: 4242, heartbeat: NOW - 60, runStatus: "running", ...over });
const facts = (over: Partial<Facts> = {}): Facts => ({ homeExists: true, record: live(), homeAgeSecs: 100, ...over });
const opt = { now: NOW, tmp: TMP };

describe("classifyRunner", () => {
  test("home-missing when HARNESS_ORCH_HOME is gone", () => {
    const j = classifyRunner(proc(), facts({ homeExists: false }), opt);
    expect(j).toMatchObject({ ghost: true, reason: "home-missing" });
  });

  test("record-missing when loop.json or watch.json or the job dir is gone", () => {
    expect(classifyRunner(proc(), facts({ record: null }), opt)).toMatchObject({ ghost: true, reason: "record-missing" });
  });

  test("record-not-running for status stopped, done, failed, cancelled", () => {
    for (const status of ["stopped", "done", "failed", "cancelled"]) {
      expect(classifyRunner(proc(), facts({ record: live({ status }) }), opt)).toMatchObject({ ghost: true, reason: "record-not-running" });
    }
  });

  test("pid-mismatch when the record pid differs", () => {
    expect(classifyRunner(proc(), facts({ record: live({ pid: 9999 }) }), opt)).toMatchObject({ ghost: true, reason: "pid-mismatch" });
  });

  test("run-finished when the run is done or cancelled", () => {
    for (const runStatus of ["done", "cancelled"]) {
      expect(classifyRunner(proc(), facts({ record: live({ runStatus, heartbeat: NOW - 4000 }) }), opt)).toMatchObject({ ghost: true, reason: "run-finished" });
    }
  });

  test("temp-test-home older than 30 minutes is a ghost, younger is not", () => {
    const p = proc({ home: TEMP_HOME });
    expect(classifyRunner(p, facts({ homeAgeSecs: 1801, record: live({ heartbeat: NOW - 4000 }) }), opt)).toMatchObject({ ghost: true, reason: "temp-test-home" });
    expect(classifyRunner(p, facts({ homeAgeSecs: 1700, record: live({ heartbeat: NOW - 4000 }) }), opt)).toMatchObject({ ghost: false, reason: null });
  });

  test("a non-temp home is never temp-test-home", () => {
    expect(isTempHome(HOME, TMP)).toBe(false);
    expect(isTempHome(`${TMP}/wdpill-9`, TMP)).toBe(true);
    expect(classifyRunner(proc(), facts({ homeAgeSecs: 999999 }), opt).ghost).toBe(false);
  });

  test("never a ghost: running, own pid, heartbeat under 5 minutes, even in an old temp home or a finished run", () => {
    const p = proc({ home: TEMP_HOME });
    expect(classifyRunner(p, facts({ homeAgeSecs: 999999, record: live({ heartbeat: NOW - 299 }) }), opt).ghost).toBe(false);
    expect(classifyRunner(p, facts({ homeAgeSecs: 999999, record: live({ heartbeat: NOW - 299, runStatus: "done" }) }), opt).ghost).toBe(false);
  });

  test("a stale heartbeat alone is not a ghost reason", () => {
    expect(classifyRunner(proc(), facts({ record: live({ heartbeat: NOW - 4000 }) }), opt).ghost).toBe(false);
  });

  test("serve is a ghost only when its home is missing", () => {
    const s = proc({ kind: "serve", id: "", command: "bun dispatch.ts serve" });
    expect(classifyRunner(s, facts({ homeExists: false, record: null }), opt)).toMatchObject({ ghost: true, reason: "home-missing" });
    expect(classifyRunner(s, facts({ record: null }), opt).ghost).toBe(false);
  });
});

describe("fake ps fixture", () => {
  const PS = [
    "  101 bun /x/scripts/dispatch.ts loop __run loop-20261117-0001-aaaa",
    "  102 bun /x/scripts/dispatch.ts watch __run watch-20261117-0002-bbbb",
    "  103 bun /x/core/cli.ts job-run /h/jobs/job-1 claude t prompt",
    "  104 bun /x/scripts/dispatch.ts serve",
    "  105 /usr/bin/vim notes.txt",
    "  106 claude --resume something",
    "  107 /Users/x/.opencode/bin/opencode run Unread answers: dispatch.ts loop __run loop-9 and cli.ts job-run /h/jobs/x",
  ].join("\n");
  const envs: Record<number, string> = {
    101: "bun dispatch.ts loop __run X PATH=/bin HARNESS_ORCH_HOME=/var/folders/x/T/orch-t-abc HOME=/Users/me",
    102: "bun dispatch.ts watch __run Y HARNESS_ORCH_HOME=/Users/me/.harness-orch",
    103: "bun cli.ts job-run /h PATH=/bin",
    104: "bun dispatch.ts serve",
  };

  test("finds only orch runners, reads each home from its env", () => {
    const rows = parseRunnerLines(PS, (pid) => homeFromEnv(envs[pid] ?? ""));
    expect(rows.map((r) => [r.pid, r.kind, r.id])).toEqual([
      [101, "loop", "loop-20261117-0001-aaaa"],
      [102, "watch", "watch-20261117-0002-bbbb"],
      [103, "job", "/h/jobs/job-1"],
      [104, "serve", ""],
    ]);
    expect(rows[0]!.home).toBe("/var/folders/x/T/orch-t-abc");
    expect(rows[2]!.home).toBeNull();
  });

  test("homeFromEnv reads NUL-separated /proc environ too", () => {
    expect(homeFromEnv("A=1\0HARNESS_ORCH_HOME=/tmp/orch-t-z\0B=2")).toBe("/tmp/orch-t-z");
    expect(homeFromEnv("A=1")).toBeNull();
  });
});

describe("judgeAll reads records from disk", () => {
  test("a missing home is judged home-missing without touching anything else", () => {
    const j = judgeAll([proc({ home: `${TMP}/orch-t-gone` })], NOW, TMP);
    expect(j[0]).toMatchObject({ ghost: true, reason: "home-missing" });
  });
});

describe("self-check", () => {
  test("reports each miss reason from its own record", () => {
    const home = `${TMP}/does-not-exist`;
    expect(selfCheckReason("loop", home, `${home}/state.json`, 1)).toBe("home-missing");
  });

  test("retries 1 s, 4 s, 16 s and clears a miss that recovers", async () => {
    const slept: number[] = [];
    let calls = 0;
    const reason = await confirmMiss(() => (++calls === 1 ? "record-missing" : null), async (s) => { slept.push(s); });
    expect(reason).toBeNull();
    expect(slept).toEqual([1]);
  });

  test("after three retries the miss is final and the runner exits", async () => {
    const slept: number[] = [];
    const reason = await confirmMiss(() => "record-not-running", async (s) => { slept.push(s); });
    expect(reason).toBe("record-not-running");
    expect(slept).toEqual([1, 4, 16]);
  });

  test("max runtime: a temp home is capped at 15 minutes, other homes keep the spec deadline", () => {
    expect(effectiveDeadline(NOW + 86400, NOW, TEMP_HOME, TMP)).toBe(NOW + 900);
    expect(effectiveDeadline(NOW + 3600, NOW, HOME, TMP)).toBe(NOW + 3600);
  });
});

describe("killGhosts", () => {
  test("kills only ghosts, with SIGTERM then SIGKILL, and never a live runner", async () => {
    const procs: RunnerProc[] = [proc({ pid: 1, home: `${TMP}/orch-t-a` }), proc({ pid: 2 })];
    const judged = [
      { pid: 1, kind: "loop" as const, id: "a", home: procs[0]!.home, ghost: true, reason: "temp-test-home" as const },
      { pid: 2, kind: "loop" as const, id: "b", home: HOME, ghost: false, reason: null },
    ];
    const sent: string[] = [];
    let alive = true;
    const n = await killGhosts(judged, procs, {
      kill: (pid, sig) => { sent.push(`${pid}:${sig}`); if (sig === "SIGKILL") alive = false; },
      alive: () => alive,
      sleep: async () => {},
      still: () => "bun dispatch.ts loop __run a",
      rejudge: () => judged[0]!,
      tmp: TMP,
    }, () => {});
    expect(n).toBe(1);
    expect(sent).toEqual(["1:SIGTERM", "1:SIGKILL"]);
  });

  test("skips a ghost whose pid now runs something else", async () => {
    const procs: RunnerProc[] = [proc({ pid: 1 })];
    const judged = [{ pid: 1, kind: "loop" as const, id: "a", home: HOME, ghost: true, reason: "record-missing" as const }];
    const sent: string[] = [];
    const n = await killGhosts(judged, procs, { kill: (p, s) => sent.push(`${p}:${s}`), alive: () => true, sleep: async () => {}, still: () => null, rejudge: () => judged[0]!, tmp: TMP }, () => {});
    expect(n).toBe(0);
    expect(sent).toEqual([]);
  });
});

const ghostJ = (pid: number, home: string, reason: any = "record-missing") => ({ pid, kind: "loop" as const, id: "a", home, ghost: true, reason });
const killDeps = (rejudge: (p: RunnerProc) => any, sent: string[] = [], sleeps: number[] = []) => ({
  kill: (pid: number, sig: NodeJS.Signals) => { sent.push(`${pid}:${sig}`); },
  alive: () => false,
  sleep: async (ms: number) => { sleeps.push(ms); },
  still: () => "bun dispatch.ts loop __run a",
  rejudge,
  tmp: TMP,
});

describe("F1 uid and unreadable env", () => {
  test("a foreign uid row is skipped", () => {
    const ps = "  10 501 bun dispatch.ts loop __run a\n  11 0 bun dispatch.ts loop __run b\n";
    expect(ownUidLines(ps, 501)).toBe("10 bun dispatch.ts loop __run a");
  });
  test("a runner whose home cannot be read is unknown: not listed, so never a ghost", () => {
    expect(parseRunnerLines("  5 bun dispatch.ts loop __run a", () => undefined)).toEqual([]);
  });
  test("homeFromEnv: absent is null, empty value is unknown", () => {
    expect(homeFromEnv("bun x PATH=/bin")).toBeNull();
    expect(homeFromEnv("bun x HARNESS_ORCH_HOME= PATH=/bin")).toBeUndefined();
  });
});

describe("F2/F4 killGhosts re-judge", () => {
  const p = proc({ pid: 7 });
  test("record reappears at the second look: no kill", async () => {
    const sent: string[] = [];
    const n = await killGhosts([ghostJ(7, HOME)], [p], killDeps(() => ({ ...ghostJ(7, HOME), ghost: false, reason: null }), sent), () => {});
    expect(n).toBe(0);
    expect(sent).toEqual([]);
  });
  test("rename race: record missing once, back within 1 s keeps the runner", async () => {
    let looks = 0;
    const sent: string[] = [];
    const n = await killGhosts([ghostJ(7, HOME)], [p], killDeps(() => (++looks === 1 ? { ...ghostJ(7, HOME), ghost: false, reason: null } : ghostJ(7, HOME)), sent), () => {});
    expect(n).toBe(0);
    expect(sent).toEqual([]);
  });
  test("a changed reason cancels the kill", async () => {
    const n = await killGhosts([ghostJ(7, HOME)], [p], killDeps(() => ghostJ(7, HOME, "home-missing")), () => {});
    expect(n).toBe(0);
  });
  test("unreadable home at a look cancels the kill", async () => {
    expect(await killGhosts([ghostJ(7, HOME)], [p], killDeps(() => null), () => {})).toBe(0);
  });
  test("real home needs three looks (2 s, then 4 s more); temp home needs two", async () => {
    let sleeps: number[] = [];
    let looks = 0;
    expect(await killGhosts([ghostJ(7, HOME)], [p], killDeps(() => (looks++, ghostJ(7, HOME)), [], sleeps), () => {})).toBe(1);
    expect(looks).toBe(2);
    expect(sleeps.slice(0, 2)).toEqual([2000, 4000]);
    sleeps = [];
    looks = 0;
    const th = TEMP_HOME;
    expect(await killGhosts([ghostJ(7, th)], [proc({ pid: 7, home: th })], killDeps(() => (looks++, ghostJ(7, th)), [], sleeps), () => {})).toBe(1);
    expect(looks).toBe(1);
  });
  test("a changing reason on the third look cancels a real-home kill", async () => {
    let looks = 0;
    const n = await killGhosts([ghostJ(7, HOME)], [p], killDeps(() => (++looks === 2 ? { ...ghostJ(7, HOME), ghost: false, reason: null } : ghostJ(7, HOME))), () => {});
    expect(n).toBe(0);
  });
});

describe("F4 job liveness from the pid file", () => {
  test("a job whose pid file names the process is live; exit_code present makes it record-not-running", () => {
    const home = mkdtempSync(join(tmpdir(), "jobhome-"));
    const dir = join(home, "jobs", "j1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pid"), "4242");
    const jp = proc({ kind: "job", id: dir, home, command: `bun /x/cli.ts job-run ${dir} claude t p` });
    expect(judgeAll([jp], NOW, TMP)[0]).toMatchObject({ ghost: false });
    writeFileSync(join(dir, "exit_code"), "0");
    expect(judgeAll([jp], NOW, TMP)[0]).toMatchObject({ ghost: true, reason: "record-not-running" });
  });
  test("a job dir with spaces in the home is resolved, a missing unresolvable one is not judged", () => {
    const home = mkdtempSync(join(tmpdir(), "job home "));
    const dir = join(home, "jobs", "j 1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "pid"), "4242");
    const jp = proc({ kind: "job", id: dir.split(" ")[0]!, home, command: `bun /x/cli.ts job-run ${dir} claude t p` });
    expect(judgeAll([jp], NOW, TMP)[0]!.ghost).toBe(false);
    const gone = proc({ kind: "job", id: "/nope/a", home, command: "bun /x/cli.ts job-run /nope/a b c" });
    expect(judgeAll([gone], NOW, TMP)[0]!.ghost).toBe(false);
  });
});

describe("F5 parsing", () => {
  test("RUNNER_RE matches bun run, node and absolute wrappers, not prose", () => {
    for (const c of [
      "bun run /x/scripts/dispatch.ts loop __run l1",
      "/opt/homebrew/bin/bun /x y/scripts/dispatch.ts watch __run w1",
      "node --no-warnings /x/core/cli.ts job-run /h/jobs/j c",
      "/x/scripts/dispatch.ts serve",
    ]) expect(RUNNER_RE.test(c)).toBe(true);
    expect(RUNNER_RE.test('node -e "run dispatch.ts loop __run l"')).toBe(false);
    expect(RUNNER_RE.test("opencode run see dispatch.ts loop __run l9")).toBe(false);
  });
  test("home with spaces: ends at the next VAR= token; ambiguous (not on disk) is unknown", () => {
    const home = mkdtempSync(join(tmpdir(), "my home "));
    expect(homeFromEnv(`bun x PATH=/bin HARNESS_ORCH_HOME=${home} LANG=en`)).toBe(home);
    expect(homeFromEnv("bun x HARNESS_ORCH_HOME=/no such dir/h LANG=en")).toBeUndefined();
    expect(homeFromEnv("A=1\0HARNESS_ORCH_HOME=/a b/c\0B=2")).toBe("/a b/c");
  });
});

describe("F6 isTempHome", () => {
  test("realpath home matches tmpdir, both ways", () => {
    const d = mkdtempSync(join(tmpdir(), "orch-t-"));
    expect(isTempHome(realpathSync(d), tmpdir())).toBe(true);
    expect(isTempHome(d, realpathSync(tmpdir()))).toBe(true);
  });
  test("the pattern must be the directory directly under tmp", () => {
    expect(isTempHome(`${TMP}/other/orch-t-x`, TMP)).toBe(false);
    expect(isTempHome(`${TMP}x/orch-t-a`, TMP)).toBe(false);
    expect(isTempHome(`${TMP}/orch-t-a/inner`, TMP)).toBe(true);
    expect(isTempHome("/Users/me/orch-test-home", TMP)).toBe(false);
  });
});
