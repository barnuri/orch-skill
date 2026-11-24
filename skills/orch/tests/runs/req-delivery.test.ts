import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoCleanup, orch, seedHome, tempDir } from "../helpers";
import { statusSnapshot } from "../../core/delivery/attribution.ts";
import { deliverReqEntry, deliverReqQueue, enqueueVerifiedReq, loadReqQueue, reqPolicy, type ReqEntry } from "../../core/delivery/req-delivery.ts";

setDefaultTimeout(60_000);
autoCleanup();

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// A private repo on master with one base commit and git identity, so `git commit` works without global config.
function makeRepo(): string {
  const repo = join(tempDir(), "private", "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "master");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "base.ts"), "export const base = 1;\n");
  git(repo, "add", "base.ts");
  git(repo, "commit", "-q", "-m", "base");
  return repo;
}

const entry = (repo: string, files: string[], tests: string[], extra: Partial<ReqEntry> = {}): ReqEntry => ({
  key: `r1/R1/repo`, run: "r1", req: "R1", text: "Make it work", repo, policy: "local-commit", nodes: ["impl"], files, tests,
  verified_at: new Date(Date.now() + 5_000).toISOString(), state: "queued", reason: null, sha: null, pr_url: null,
  enqueued_at: "t", updated: "t", ...extra,
});

const committed = (repo: string): string[] => git(repo, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);

describe("requirement delivery: local commit", () => {
  test("commits only the tested files, with the requirement and tests in the message", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(repo, "other.ts"), "unrelated work of another node\n");
    const r = await deliverReqEntry(entry(repo, ["a.ts"], ["test -f a.ts"]), { home: seedHome(), running: new Map() });
    expect(r.state).toBe("committed");
    expect(r.sha).toBe(git(repo, "rev-parse", "HEAD"));
    expect(committed(repo)).toEqual(["a.ts"]);
    expect(git(repo, "log", "-1", "--format=%B")).toContain("R1");
    expect(git(repo, "log", "-1", "--format=%B")).toContain("test -f a.ts");
    expect(git(repo, "status", "--porcelain")).toContain("other.ts");
  });

  test("a failing test blocks the entry and commits nothing", async () => {
    const repo = makeRepo();
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "x\n");
    const r = await deliverReqEntry(entry(repo, ["a.ts"], ["false"]), { home: seedHome(), running: new Map() });
    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("test failed");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  });

  test("an entry without tests is not committed", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "x\n");
    const r = await deliverReqEntry(entry(repo, ["a.ts"], []), { home: seedHome(), running: new Map() });
    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("no tests");
  });

  test("a file a running node is editing blocks the entry", async () => {
    const repo = makeRepo();
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "x\n");
    const r = await deliverReqEntry(entry(repo, ["a.ts"], ["true"]), { home: seedHome(), running: new Map([["a.ts", "r2/busy"]]) });
    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("r2/busy");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  });

  test("a file changed after the verifier passed blocks the entry", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "a.ts"), "x\n");
    const r = await deliverReqEntry(entry(repo, ["a.ts"], ["true"], { verified_at: new Date(Date.now() - 60_000).toISOString() }), { home: seedHome(), running: new Map() });
    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("after the verifier passed");
  });

  test("conflict markers block the entry", async () => {
    const repo = makeRepo();
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> other\n");
    const r = await deliverReqEntry(entry(repo, ["a.ts"], ["true"]), { home: seedHome(), running: new Map() });
    expect(r.state).toBe("blocked");
    expect(r.reason).toContain("conflict markers");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  });

  test("--dry-run plans the commit and writes nothing", async () => {
    const repo = makeRepo();
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(join(repo, "a.ts"), "x\n");
    const r = await deliverReqEntry(entry(repo, ["a.ts"], ["true"]), { home: seedHome(), running: new Map(), dryRun: true });
    expect(r.state).toBe("queued");
    expect(r.plan.join("\n")).toContain("git commit");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(git(repo, "diff", "--cached", "--name-only")).toBe("");
  });
});

describe("requirement delivery: policy", () => {
  test("a private repo without a PR rule commits locally; a repo that talks about PRs opens one", () => {
    expect(reqPolicy("/x/private/orch", "Run tests before commit.")).toBe("local-commit");
    expect(reqPolicy("/x/private/hub", "Its table goes in the PR body.")).toBe("pr");
    expect(reqPolicy("/x/work/app", "")).toBe("pr");
  });
});

describe("requirement delivery: from the ledger", () => {
  test("a verified requirement queues its implementer's files and tests; a running node's file blocks; delivery records the sha", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "earlier.ts"), "dirty before dispatch\n");
    const home = seedHome();
    const o = orch(home);
    const run = o("run", "start", "Deliver", "--id", "deliv-1").out.trim();
    const job = (id: string) => {
      const d = join(home, "jobs", `job-${id}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "repo"), repo + "\n");
      writeFileSync(join(d, "start_commit"), git(repo, "rev-parse", "HEAD") + "\n");
      writeFileSync(join(d, "start_status.json"), JSON.stringify(statusSnapshot(repo)));
      return `job-${id}`;
    };
    o("node", "add", run, "impl", "Implement", "--profile", "claude-default");
    o("node", "update", run, "impl", "running", "--job", job("impl"), "--force");
    writeFileSync(join(repo, "feature.ts"), "export const f = 1;\n");
    o("node", "add", run, "busy", "Other work", "--profile", "claude-default");
    o("node", "update", run, "busy", "running", "--job", job("busy"), "--force");
    writeFileSync(join(repo, "busy.ts"), "in progress\n");
    o("req", "add", run, "Feature", "--id", "R1", "--node", "impl");
    o("req", "evidence", run, "R1", "--note", "tested", "--test", "test -f feature.ts");
    expect(o("req", "status", run, "R1", "done", "--force", "--reason", "test").rc).toBe(0);

    expect(await enqueueVerifiedReq(home, run, "R1")).toHaveLength(1);
    const e = Object.values(loadReqQueue(home).entries)[0]!;
    expect(e.files).toEqual(["feature.ts"]);
    expect(e.tests).toEqual(["test -f feature.ts"]);
    expect(e.policy).toBe("local-commit");
    expect(await enqueueVerifiedReq(home, run, "R1")).toHaveLength(0);

    const notes: string[] = [];
    const [r] = await deliverReqQueue({ home, record: async (_e, n) => void notes.push(n) });
    expect(r!.state).toBe("committed");
    expect(committed(repo)).toEqual(["feature.ts"]);
    expect(notes[0]).toContain(`delivered ${r!.sha}`);
    expect(loadReqQueue(home).entries[e.key]!.state).toBe("committed");
    // The running node's file and the file dirty before dispatch stay uncommitted.
    expect(git(repo, "status", "--porcelain")).toContain("busy.ts");
    expect(git(repo, "status", "--porcelain")).toContain("earlier.ts");
  });

  test("a file the implementer shares with a running node is blocked", async () => {
    const repo = makeRepo();
    const home = seedHome();
    const o = orch(home);
    const run = o("run", "start", "Deliver", "--id", "deliv-2").out.trim();
    const job = (id: string) => {
      const d = join(home, "jobs", `job-${id}`);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "repo"), repo + "\n");
      writeFileSync(join(d, "start_commit"), git(repo, "rev-parse", "HEAD") + "\n");
      writeFileSync(join(d, "start_status.json"), "{}");
      return `job-${id}`;
    };
    o("node", "add", run, "impl", "Implement", "--profile", "claude-default");
    o("node", "update", run, "impl", "running", "--job", job("impl"), "--force");
    o("node", "add", run, "busy", "Other work", "--profile", "claude-default");
    o("node", "update", run, "busy", "running", "--job", job("busy"), "--force");
    writeFileSync(join(repo, "shared.ts"), "both\n");
    mkdirSync(join(home, "runs", run, "out", "impl"), { recursive: true });
    writeFileSync(join(home, "runs", run, "out", "impl", "handoff.md"), "Changed shared.ts\n");
    o("req", "add", run, "Feature", "--id", "R1", "--node", "impl");
    o("req", "evidence", run, "R1", "--note", "tested", "--test", "true");
    o("req", "status", run, "R1", "done", "--force", "--reason", "test");
    await enqueueVerifiedReq(home, run, "R1");
    const head = git(repo, "rev-parse", "HEAD");
    const [r] = await deliverReqQueue({ home, record: async () => {} });
    expect(r!.state).toBe("blocked");
    expect(r!.reason).toContain(`${run}/busy`);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  });
});
