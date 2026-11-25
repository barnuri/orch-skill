import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

describe("requirement delivery: named files and one key", () => {
  test("enqueue --files --test queues an unverified requirement; run --key commits only it; run --run skips other runs' commit groups", async () => {
    const repo = makeRepo();
    const home = seedHome();
    const o = orch(home);
    const run = o("run", "start", "Deliver", "--id", "deliv-3").out.trim();
    o("req", "add", run, "Delivery works", "--id", "G8");
    o("req", "add", run, "Other", "--id", "G9");
    o("req", "status", run, "G8", "in_progress");
    o("req", "status", run, "G9", "in_progress");
    writeFileSync(join(repo, "fix.ts"), "export const fix = 1;\n");
    writeFileSync(join(repo, "other.ts"), "not named\n");

    expect(o("delivery", "enqueue", run, "G8", "--files", "fix.ts", "--repo", repo).rc).toBe(2);
    expect(o("delivery", "enqueue", run, "G8", "--files", "nope.ts", "--test", "true", "--repo", repo).rc).toBe(2);
    const enq = o("delivery", "enqueue", run, "G8", "--files", "fix.ts", "--test", "test -f fix.ts", "--repo", repo);
    expect(enq.rc).toBe(0);
    const key = `${run}/G8/repo`;
    expect(enq.out).toContain(`queued ${key}`);
    const e = loadReqQueue(home).entries[key]!;
    expect(e.files).toEqual(["fix.ts"]);
    expect(e.tests).toEqual(["test -f fix.ts"]);
    expect(e.policy).toBe("local-commit");

    // A second requirement entry in the queue stays untouched by --key.
    writeFileSync(join(repo, "g9.ts"), "g9\n");
    expect(o("delivery", "enqueue", run, "G9", "--files", "g9.ts", "--test", "true", "--repo", repo).rc).toBe(0);
    // A commit-queue entry of another run: --key must not touch it (no ff-merge, no push).
    mkdirSync(join(home, "delivery"), { recursive: true });
    const other = { key: "other-run/n", run: "other-run", node: "n", repo, branch: "master", worktree: repo, commits: [], touched: ["x.ts"], state: "queued", group: null, refused_reason: null, enqueued_at: "t" };
    writeFileSync(join(home, "delivery", "queue.json"), JSON.stringify({ version: 1, entries: { [other.key]: other } }));

    expect(o("delivery", "run", "--key", "nope").rc).toBe(2);
    const head = git(repo, "rev-parse", "HEAD");
    const res = o("delivery", "run", "--key", key);
    expect(res.rc).toBe(0);
    const sha = git(repo, "rev-parse", "HEAD");
    expect(sha).not.toBe(head);
    expect(res.out).toContain(`${key} committed ${sha}`);
    expect(committed(repo)).toEqual(["fix.ts"]);
    expect(git(repo, "log", "-1", "--format=%s")).toStartWith("orch: deliver G8");
    const q = loadReqQueue(home);
    expect(q.entries[key]!.state).toBe("committed");
    expect(q.entries[key]!.sha).toBe(sha);
    expect(q.entries[`${run}/G9/repo`]!.state).toBe("queued");
    expect(git(repo, "status", "--porcelain")).toContain("other.ts");
    // The delivered sha is recorded on the requirement as evidence.
    expect(o("req", "list", run, "--json").out).toContain(`delivered ${sha}`);
    // The other run's commit entry was not grouped or delivered.
    const cq = JSON.parse(readFileSync(join(home, "delivery", "queue.json"), "utf8"));
    expect(cq.entries[other.key].state).toBe("queued");

    // --run limits commit groups to that run: the other run's entry stays queued.
    o("delivery", "run", "--run", run);
    expect(JSON.parse(readFileSync(join(home, "delivery", "queue.json"), "utf8")).entries[other.key].state).toBe("queued");

    // A committed key is not re-queued.
    expect(o("delivery", "enqueue", run, "G8", "--files", "fix.ts", "--test", "true", "--repo", repo).rc).toBe(2);
  });
});

describe("requirement delivery: enqueue needs evidence", () => {
  const setup = (id: string) => {
    const repo = makeRepo();
    const home = seedHome();
    const o = orch(home);
    const run = o("run", "start", "Deliver", "--id", id).out.trim();
    const d = join(home, "jobs", "job-impl");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "repo"), repo + "\n");
    writeFileSync(join(d, "start_commit"), git(repo, "rev-parse", "HEAD") + "\n");
    writeFileSync(join(d, "start_status.json"), JSON.stringify(statusSnapshot(repo)));
    o("node", "add", run, "impl", "Implement", "--profile", "claude-default");
    o("node", "update", run, "impl", "running", "--job", "job-impl", "--force");
    writeFileSync(join(repo, "feature.ts"), "export const f = 1;\n");
    o("req", "add", run, "Feature", "--id", "R1", "--node", "impl");
    return { repo, home, o, run };
  };
  const ledgerNotes = (home: string, run: string): string[] =>
    (JSON.parse(require("node:fs").readFileSync(join(home, "runs", run, "requirements.json"), "utf8")).requirements[0].evidence as { note: string }[]).map((e) => e.note);

  test("a requirement without test commands is refused loudly, not queued with empty tests", async () => {
    const { home, o, run } = setup("deliv-3");
    o("req", "evidence", run, "R1", "--note", "done, no test");
    o("req", "status", run, "R1", "done", "--force", "--reason", "test");
    const r = o("delivery", "enqueue", run, "R1");
    expect(r.rc).toBe(1);
    expect(r.err).toContain("refused");
    expect(r.err).toContain("no test commands");
    expect(Object.keys(loadReqQueue(home).entries)).toHaveLength(0);
    // After the evidence gains a test command the same requirement queues.
    o("req", "evidence", run, "R1", "--note", "tested", "--test", "test -f feature.ts");
    const ok = o("delivery", "enqueue", run, "R1");
    expect(ok.rc).toBe(0);
    const key = Object.keys(loadReqQueue(home).entries)[0]!;
    // A dropped entry can be queued again.
    expect(o("delivery", "drop", key, "--reason", "stale").rc).toBe(0);
    expect(o("delivery", "enqueue", run, "R1").out).toContain(`queued ${key}`);
    expect(loadReqQueue(home).entries[key]!.state).toBe("queued");
  });

  test("--test is recorded as evidence and the queued entry carries it and the files", async () => {
    const { home, o, run, repo } = setup("deliv-4");
    o("node", "add", run, "v1", "Verifier", "--profile", "local-llm-fast");
    o("req", "evidence", run, "R1", "--note", "built");
    expect(o("req", "status", run, "R1", "implemented", "--by", "impl").rc).toBe(0);
    expect(o("req", "status", run, "R1", "verifying", "--verifier", "v1").rc).toBe(0);
    expect(o("req", "verdict", run, "R1", "pass", "--node", "v1", "--note", "ok", "--test", "test -f feature.ts").rc).toBe(0);
    const e = Object.values(loadReqQueue(home).entries)[0]!;
    expect(e.tests).toEqual(["test -f feature.ts"]);
    expect(e.files).toEqual(["feature.ts"]);
    expect(ledgerNotes(home, run).some((n) => n.startsWith("delivery queued:"))).toBe(true);
    const [d] = await deliverReqQueue({ home, record: async () => {} });
    expect(d!.state).toBe("committed");
    expect(committed(repo)).toEqual(["feature.ts"]);
  });

  test("a verifier pass with no test command writes a 'delivery not queued' note instead of an empty entry", () => {
    const { home, o, run } = setup("deliv-5");
    o("node", "add", run, "v1", "Verifier", "--profile", "local-llm-fast");
    o("req", "evidence", run, "R1", "--note", "built");
    o("req", "status", run, "R1", "implemented", "--by", "impl");
    o("req", "status", run, "R1", "verifying", "--verifier", "v1");
    const r = o("req", "verdict", run, "R1", "pass", "--node", "v1", "--note", "ok");
    expect(r.rc).toBe(0);
    expect(r.err).toContain("delivery not queued");
    expect(Object.keys(loadReqQueue(home).entries)).toHaveLength(0);
    expect(ledgerNotes(home, run).some((n) => n.includes("no test commands"))).toBe(true);
  });
});
