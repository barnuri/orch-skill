import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAppCache, hcJobTail, hcEnabled, hcSweep, herdrCommand, herdrEnabled, jobGoneNote, startJob, sweep } from "./herdr.ts";

// A herdr stub: answers status/workspace/tab/pane calls from a call log, records every call.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "herdr-ts-"));
  const home = join(root, "h");
  const bin = join(root, "bin");
  mkdirSync(join(home, "jobs"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(home, "profiles.json"), JSON.stringify({ settings: {}, profiles: {} }));
  const log = join(root, "calls.log");
  const panes = join(root, "panes.json");
  writeFileSync(panes, JSON.stringify({ result: { panes: [] } }));
  writeFileSync(join(bin, "herdr"), `#!/bin/sh
echo "$*" >> "${log}"
case "$1 $2" in
  "status --json") echo '{"server":{"running":true}}' ;;
  "workspace list") echo '{"result":{"workspaces":[]}}' ;;
  "workspace create") echo '{"result":{"workspace":{"workspace_id":"w1"},"tab":{"tab_id":"t0"},"root_pane":{"pane_id":"p0"}}}' ;;
  "tab create") echo '{"result":{"tab":{"tab_id":"t1"},"root_pane":{"pane_id":"p1"}}}' ;;
  "tab list") echo '{"result":{"tabs":[{"tab_id":"t1","label":"[1] n1"}]}}' ;;
  "pane list") cat "${panes}" ;;
  *) echo '{}' ;;
esac
`);
  chmodSync(join(bin, "herdr"), 0o755);
  return { root, home, bin, log, panes };
}

// ORCH_HC=0 by default so a real `hc` on PATH never runs; the hc tests pass ORCH_HC=1 themselves.
function withEnv<T>(overrides: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const env = { ORCH_HC: "0", ORCH_HERDR_SPACE: "off", ...overrides };
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  return fn().finally(() => { for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v); });
}

describe("herdr", () => {
  test("ORCH_HERDR=0 disables it", async () => {
    const s = setup();
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}`, ORCH_HERDR: "0" }, async () => {
      expect(await herdrEnabled(s.home)).toBe(false);
      expect(await startJob(s.home, join(s.home, "jobs", "j"), ["true"])).toBe(false);
    });
  });

  test("startJob makes one tab per node titled by the node id and records the job files", async () => {
    const s = setup();
    const job = join(s.home, "jobs", "j1");
    mkdirSync(job);
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}`, ORCH_HERDR: "1", ORCH_RUN_ID: "r1", ORCH_NODE_ID: "n1", ORCH_HERDR_WEB_ENVS_DIR: join(s.root, "envs") }, async () => {
      expect(await startJob(s.home, job, ["true", "a"])).toBe(true);
    });
    const calls = readFileSync(s.log, "utf8");
    expect(calls).toContain("tab create --workspace w1");
    expect(calls).toContain("--label n1 --no-focus");
    expect(readFileSync(join(job, "herdr_pane"), "utf8")).toBe("p1\n");
    expect(readFileSync(join(job, "herdr_tab"), "utf8")).toBe("t1\n");
    expect(existsSync(join(job, "herdr_sock"))).toBe(true);
    expect(JSON.parse(readFileSync(join(job, "argv.json"), "utf8"))).toEqual(["true", "a"]);
  }, 30000);

  test("a retry reuses the node tab and titles it with the attempt", async () => {
    const s = setup();
    const job = join(s.home, "jobs", "j2");
    mkdirSync(job);
    writeFileSync(s.panes, JSON.stringify({ result: { panes: [{ pane_id: "p1", tab_id: "t1" }] } }));
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}`, ORCH_HERDR: "1", ORCH_RUN_ID: "r1", ORCH_NODE_ID: "n1", ORCH_NODE_ATTEMPT: "2", ORCH_HERDR_WEB_ENVS_DIR: join(s.root, "envs") }, async () => {
      expect(await startJob(s.home, job, ["true"])).toBe(true);
    });
    const calls = readFileSync(s.log, "utf8");
    expect(calls).toContain("tab rename t1 n1 #2");
    expect(calls).not.toContain("tab create");
  }, 30000);

  test("sweep closes an ended job's tab after the linger and an orphan after 60 s, never a running one", async () => {
    const s = setup();
    const mk = (name: string, pane: string, tab: string, endedAgo: number | null) => {
      const d = join(s.home, "jobs", name);
      mkdirSync(d);
      writeFileSync(join(d, "herdr_pane"), `${pane}\n`);
      writeFileSync(join(d, "herdr_tab"), `${tab}\n`);
      if (endedAgo !== null) {
        writeFileSync(join(d, "exit_code"), "0");
        writeFileSync(join(d, "ended_at"), new Date(Date.now() - endedAgo * 1000).toISOString());
      } else writeFileSync(join(d, "pid"), String(process.pid));
      mkdirSync(join(s.home, "herdr", "tabs"), { recursive: true });
      writeFileSync(join(s.home, "herdr", "tabs", `${tab}.job`), `${d}\n`);
    };
    mk("old", "p1", "t1", 400);
    mk("fresh", "p2", "t2", 10);
    mk("live", "p3", "t3", null);
    writeFileSync(s.panes, JSON.stringify({ result: { panes: [
      { pane_id: "p1", tab_id: "t1" }, { pane_id: "p2", tab_id: "t2" }, { pane_id: "p3", tab_id: "t3" }, { pane_id: "px", tab_id: "tx" },
    ] } }));
    writeFileSync(join(s.home, "herdr", "orphans.json"), JSON.stringify({ px: Date.now() / 1000 - 120 }));
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}`, ORCH_HERDR: "1" }, async () => {
      expect(await sweep(s.home)).toBe(2);
    });
    const closes = readFileSync(s.log, "utf8").split("\n").filter((l) => l.startsWith("tab close"));
    expect(closes.sort()).toEqual(["tab close t1", "tab close tx"]);
  });

  test("an unknown verb prints usage and exits 2", async () => {
    expect(await herdrCommand("bogus", [], mkdtempSync(join(tmpdir(), "herdr-u-")))).toBe(2);
  });

  test("jobGoneNote names the pane", () => {
    const d = mkdtempSync(join(tmpdir(), "herdr-g-"));
    writeFileSync(join(d, "herdr_pane"), "p9\n");
    expect(jobGoneNote(d)).toContain("pane p9");
  });

  test("with hc on PATH the job runs as an hc terminal and herdr is not called", async () => {
    const s = setup();
    const hcLog = join(s.root, "hc.log");
    writeFileSync(join(s.bin, "hc"), `#!/bin/sh
echo "$*" >> "${hcLog}"
case "$1" in
  run) echo '{"address":"t9","state":"live"}' ;;
  ls) echo '{"hidden_finished":0,"terminals":[]}' ;;
  *) echo '{}' ;;
esac
`);
    chmodSync(join(s.bin, "hc"), 0o755);
    const job = join(s.home, "jobs", "hc1");
    mkdirSync(job);
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}`, ORCH_HC: "1", ORCH_RUN_ID: "r1", ORCH_NODE_ID: "n1", ORCH_HERDR_WEB_ENVS_DIR: join(s.root, "envs") }, async () => {
      expect(await startJob(s.home, job, ["true", "a"])).toBe(true);
    });
    const hc = readFileSync(hcLog, "utf8");
    expect(hc).toContain("run --bg --json");
    expect(hc).toContain("--label orch=1");
    expect(hc).toContain("--label node=n1");
    expect(readFileSync(join(job, "hc_term"), "utf8")).toBe("t9\n");
    expect(existsSync(join(job, "herdr_pane"))).toBe(false);
    expect(existsSync(s.log) && readFileSync(s.log, "utf8").includes("tab create")).toBe(false);
  });

  test("ORCH_HC=0 keeps the herdr path", async () => {
    const s = setup();
    writeFileSync(join(s.bin, "hc"), "#!/bin/sh\necho called >> \"" + join(s.root, "hc.log") + "\"\necho '{}'\n");
    chmodSync(join(s.bin, "hc"), 0o755);
    const job = join(s.home, "jobs", "hc2");
    mkdirSync(job);
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}`, ORCH_HC: "0", ORCH_HERDR: "1", ORCH_RUN_ID: "r1", ORCH_NODE_ID: "n1", ORCH_HERDR_WEB_ENVS_DIR: join(s.root, "envs") }, async () => {
      expect(await startJob(s.home, job, ["true", "a"])).toBe(true);
    });
    expect(existsSync(join(s.root, "hc.log"))).toBe(false);
    expect(readFileSync(join(job, "herdr_pane"), "utf8")).toBe("p1\n");
  }, 30000);

  test("hcJobTail reads the terminal with a fake hc, and is empty without hc_term or on failure", async () => {
    const s = setup();
    writeFileSync(join(s.bin, "hc"), "#!/bin/sh\nif [ \"$1\" = read ] && [ \"$2\" = t9 ]; then printf 'a\\n\\nhello  \\n\\n'; exit 0; fi\nexit 1\n");
    chmodSync(join(s.bin, "hc"), 0o755);
    const job = join(s.home, "jobs", "tail1");
    mkdirSync(job);
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}` }, async () => {
      expect(await hcJobTail(job)).toEqual([]);
      writeFileSync(join(job, "hc_term"), "t9\n");
      expect(await hcJobTail(job)).toEqual(["a", "hello"]);
      writeFileSync(join(job, "hc_term"), "t1\n");
      expect(await hcJobTail(job)).toEqual([]);
    });
  });

  test("hcEnabled needs the hc binary and honours ORCH_HC and ORCH_HERDR", async () => {
    const s = setup();
    writeFileSync(join(s.bin, "hc"), "#!/bin/sh\necho '{}'\n");
    chmodSync(join(s.bin, "hc"), 0o755);
    const withHc = `${s.bin}:${process.env.PATH}`;
    await withEnv({ PATH: withHc, ORCH_HC: "0" }, async () => expect(await hcEnabled(s.home)).toBe(false));
    await withEnv({ PATH: withHc, ORCH_HC: "1", ORCH_HERDR: "0" }, async () => expect(await hcEnabled(s.home)).toBe(false));
    await withEnv({ PATH: withHc, ORCH_HC: "1", ORCH_HERDR: "1" }, async () => expect(await hcEnabled(s.home)).toBe(true));
    await withEnv({ PATH: "/nonexistent", ORCH_HC: "1", ORCH_HERDR: "1" }, async () => expect(await hcEnabled(s.home)).toBe(false));
  });

  test("when hc run fails, startJob falls back to the herdr pane", async () => {
    const s = setup();
    writeFileSync(join(s.bin, "hc"), `#!/bin/sh
case "$1" in
  run) exit 1 ;;
  ls) echo '{"terminals":[]}' ;;
  *) echo '{}' ;;
esac
`);
    chmodSync(join(s.bin, "hc"), 0o755);
    const job = join(s.home, "jobs", "hc3");
    mkdirSync(job);
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}`, ORCH_HC: "1", ORCH_HERDR: "1", ORCH_RUN_ID: "r1", ORCH_NODE_ID: "n1", ORCH_HERDR_WEB_ENVS_DIR: join(s.root, "envs") }, async () => {
      expect(await startJob(s.home, job, ["true", "a"])).toBe(true);
    });
    expect(readFileSync(join(job, "herdr_pane"), "utf8")).toBe("p1\n");
    expect(existsSync(join(job, "hc_term"))).toBe(false);
    expect(readFileSync(s.log, "utf8")).toContain("tab create --workspace w1");
  }, 30000);

  test("hcSweep removes an ended hc terminal after the linger and keeps a running one", async () => {
    const s = setup();
    writeFileSync(join(s.bin, "hc"), `#!/bin/sh
echo "$*" >> "${join(s.root, "hc.log")}"
echo '{}'
`);
    chmodSync(join(s.bin, "hc"), 0o755);
    const mk = (name: string, addr: string, endedAgo: number | null) => {
      const d = join(s.home, "jobs", name);
      mkdirSync(d);
      writeFileSync(join(d, "hc_term"), `${addr}\n`);
      if (endedAgo !== null) {
        writeFileSync(join(d, "exit_code"), "0");
        const t = new Date(Date.now() - endedAgo * 1000);
        utimesSync(join(d, "exit_code"), t, t);
      } else writeFileSync(join(d, "pid"), String(process.pid));
      return d;
    };
    const ended = mk("ended", "t-old", 400);
    const running = mk("running", "t-live", null);
    mk("fresh", "t-fresh", 5);
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}`, ORCH_HC: "1", ORCH_HERDR: "1", ORCH_HERDR_CLOSE_AFTER: "60" }, async () => {
      expect(await hcSweep(s.home)).toBe(1);
    });
    const hc = readFileSync(join(s.root, "hc.log"), "utf8");
    expect(hc).toContain("rm t-old");
    expect(hc).not.toContain("rm t-live");
    expect(hc).not.toContain("rm t-fresh");
    expect(existsSync(join(ended, "hc_term"))).toBe(false);
    expect(existsSync(join(running, "hc_term"))).toBe(true);
  });
});

describe("herdr-app placement of hc jobs", () => {
  function fake(s: ReturnType<typeof setup>, opts: { spaces: string; createFails?: boolean; absent?: boolean; setting?: string }) {
    const hcLog = join(s.root, "hc.log"), appLog = join(s.root, "app.log");
    writeFileSync(join(s.bin, "hc"), `#!/bin/sh
echo "$*" >> "${hcLog}"
case "$1" in
  run) echo '{"address":"t9","state":"live"}' ;;
  ls) echo '{"hidden_finished":0,"terminals":[]}' ;;
  *) echo '{}' ;;
esac
`);
    chmodSync(join(s.bin, "hc"), 0o755);
    if (!opts.absent) {
      writeFileSync(join(s.bin, "herdr-app"), `#!/bin/sh
echo "$*" >> "${appLog}"
case "$1 $2" in
  "status ") echo '{}' ;;
  "ls ") echo '${opts.spaces}' ;;
  "do space.new") ${opts.createFails ? "exit 1" : `echo '{"id":"spa1"}'`} ;;
  "do tab.new") echo '{"id":"tbN'$$'"}' | sed 's/\$\$//;s/tbN[0-9]*/tbaa'$(wc -l < "${appLog}" | tr -d ' ')'/' ;;
  *) echo '{}' ;;
esac
`);
      chmodSync(join(s.bin, "herdr-app"), 0o755);
    }
    if (opts.setting !== undefined) writeFileSync(join(s.home, "profiles.json"), JSON.stringify({ settings: { herdr_space: opts.setting } }));
    return { hcLog, appLog };
  }
  const run = async (s: ReturnType<typeof setup>, name: string, runId = "r1", onlyBin = false) => {
    const job = join(s.home, "jobs", name);
    mkdirSync(job, { recursive: true });
    await withEnv({ PATH: onlyBin ? `${s.bin}:/usr/bin:/bin` : `${s.bin}:${process.env.PATH}`, ORCH_HC: "1", ORCH_HERDR_SPACE: "default", ORCH_RUN_ID: runId, ORCH_NODE_ID: "n1" }, async () => {
      expect(await startJob(s.home, job, ["true"])).toBe(true);
    });
    return job;
  };
  const rd = (f: string) => (existsSync(f) ? readFileSync(f, "utf8") : "");
  const EXIST = '{"spaces":[{"id":"spa7","name":"orch","tabs":[]}]}';

  test("space exists: labels use it, no space.new", async () => {
    resetAppCache();
    const s = setup(); const f = fake(s, { spaces: EXIST });
    await run(s, "a1");
    expect(rd(f.appLog)).not.toContain("space.new");
    expect(rd(f.hcLog)).toContain("--label herdr.space=spa7");
    expect(rd(f.hcLog)).toMatch(/--label herdr\.tab=tb\w+/);
  });
  test("run tab already in the app (other process): reused, no tab.new; another run's tab is never touched", async () => {
    resetAppCache();
    const s = setup();
    const f = fake(s, { spaces: '{"spaces":[{"id":"spa7","name":"orch","tabs":[{"id":"tbA","name":"run-A-000001"},{"id":"tbB","name":"run-B-000002"}]}]}' });
    await run(s, "c1", "run-B-000002");
    expect(rd(f.appLog)).not.toContain("tab.new");
    expect(rd(f.appLog)).not.toMatch(/close|rm /);
    expect(rd(f.hcLog)).toContain("herdr.tab=tbB");
  });
  test("space missing: created once across jobs", async () => {
    resetAppCache();
    const s = setup(); const f = fake(s, { spaces: '{"spaces":[]}' });
    await run(s, "b1"); await run(s, "b2");
    // fake ls never lists it, so the second job re-resolves, but the 60 s cache keeps the id only when listed
    expect(rd(f.appLog)).toContain("do space.new --name orch --folder");
    expect(rd(f.appLog)).toContain("--focus false");
    expect(rd(f.hcLog)).toContain("herdr.space=spa1");
  });
  test("herdr-app absent: job runs hidden", async () => {
    resetAppCache();
    const s = setup(); const f = fake(s, { spaces: EXIST, absent: true });
    const job = await run(s, "c1", "r1", true);
    expect(rd(f.hcLog)).not.toContain("herdr.space");
    expect(rd(join(job, "hc_term"))).toBe("t9\n");
  });
  test("space create fails: job still starts, one log line", async () => {
    resetAppCache();
    const s = setup(); const f = fake(s, { spaces: '{"spaces":[]}', createFails: true });
    const job = await run(s, "d1");
    expect(rd(f.hcLog)).not.toContain("herdr.space");
    expect(rd(join(job, "log"))).toContain("herdr-app:");
    expect(rd(join(job, "hc_term"))).toBe("t9\n");
  });
  test("setting off disables", async () => {
    resetAppCache();
    const s = setup(); const f = fake(s, { spaces: EXIST, setting: "off" });
    await run(s, "e1");
    expect(rd(f.appLog)).toBe("");
    expect(rd(f.hcLog)).not.toContain("herdr.space");
  });
  test("one tab per run, reused by its jobs, new tab for another run", async () => {
    resetAppCache();
    const s = setup(); const f = fake(s, { spaces: EXIST });
    await run(s, "f1", "runA"); await run(s, "f2", "runA"); await run(s, "f3", "runB");
    expect((rd(f.appLog).match(/do tab\.new/g) ?? []).length).toBe(2);
  });
  test("sweep keeps a failed app job and removes a successful one", async () => {
    resetAppCache();
    const s = setup(); const f = fake(s, { spaces: EXIST });
    const ok = await run(s, "g1"); const bad = await run(s, "g2");
    writeFileSync(join(ok, "exit_code"), "0\n"); writeFileSync(join(bad, "exit_code"), "1\n");
    writeFileSync(join(s.home, "profiles.json"), JSON.stringify({ settings: { herdr_linger_sec: 0 } }));
    await withEnv({ PATH: `${s.bin}:${process.env.PATH}`, ORCH_HC: "1" }, async () => { await new Promise((r) => setTimeout(r, 20)); expect(await hcSweep(s.home)).toBe(1); });
    expect(existsSync(join(bad, "hc_term"))).toBe(true);
    expect(existsSync(join(ok, "hc_term"))).toBe(false);
  });
});
