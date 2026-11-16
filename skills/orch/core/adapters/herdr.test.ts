import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrCommand, herdrEnabled, jobGoneNote, startJob, sweep } from "./herdr.ts";

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

function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
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
  });

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
  });

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
});
