import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";

// git process start is slow on this machine (0.3-0.8 s per call), so each test gets 120 s.
setDefaultTimeout(120_000);
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliverPending } from "../../core/delivery/deliver.ts";
import { enqueue, entryKey, loadQueue, saveQueue, type DeliveryMode } from "../../core/delivery/queue.ts";

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

// A repo under a `private` folder (direct-commit eligible) on master with one base commit.
function makeRepo(): { root: string; repo: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "deliv-"));
  roots.push(root);
  const repo = join(root, "private", "repo");
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "master");
  writeFileSync(join(repo, "base.txt"), "base\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  return { root, repo, home: join(root, "home") };
}

// A feature branch off master with one commit that touches `file`. Returns the commit sha, back on master.
function featureCommit(repo: string, branch: string, file: string, content: string): string {
  git(repo, "checkout", "-q", "-b", branch);
  writeFileSync(join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", `add ${file}`);
  const sha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "master");
  return sha;
}

function queueEntry(home: string, repo: string, node: string, branch: string, sha: string, file: string, t: string) {
  const q = loadQueue(home);
  const { queue } = enqueue(q, { run: "r1", node, repo, branch, worktree: repo, commits: [sha], touched: [file] }, t);
  saveQueue(home, queue);
}

const direct = (): DeliveryMode => "direct";

describe("delivery supervisor: direct path", () => {
  test("cherry-picks a node's commit into the integration worktree, fast-forwards master, keeps unrelated dirty work", async () => {
    const { repo, home } = makeRepo();
    const sha = featureCommit(repo, "feat-a", "a.txt", "a\n");
    queueEntry(home, repo, "a", "feat-a", sha, "a.txt", "2026-01-01T00:00:00Z");
    writeFileSync(join(repo, "unrelated.txt"), "user work, uncommitted\n");

    const res = await deliverPending({ home, now: "t", defaultBranch: "master", repoPolicy: () => ({ mode: "direct", defaultBranch: "master" }) });

    expect(res).toHaveLength(1);
    expect(res[0]!.outcome).toBe("delivered");
    expect(existsSync(join(repo, "a.txt"))).toBe(true);
    expect(readFileSync(join(repo, "unrelated.txt"), "utf8")).toBe("user work, uncommitted\n");
    expect(loadQueue(home).entries[entryKey("r1", "a")]?.state).toBe("delivered");
    const evidence = readdirSync(join(home, "delivery", "evidence"));
    expect(evidence).toHaveLength(1);
  });

  test("a failing check stops the group: nothing reaches master", async () => {
    const { repo, home } = makeRepo();
    const before = git(repo, "rev-parse", "master");
    const sha = featureCommit(repo, "feat-c", "c.txt", "c\n");
    queueEntry(home, repo, "c", "feat-c", sha, "c.txt", "2026-01-01T00:00:00Z");

    const res = await deliverPending({ home, now: "t", defaultBranch: "master", checks: [["false"]], repoPolicy: () => ({ mode: "direct", defaultBranch: "master" }) });

    expect(res[0]!.outcome).toBe("failed");
    expect(git(repo, "rev-parse", "master")).toBe(before);
    expect(loadQueue(home).entries[entryKey("r1", "c")]?.state).toBe("queued");
  });
});

describe("delivery supervisor: PR path", () => {
  test("pushes one delivery branch for the group and records the PR URL", async () => {
    const { root, repo, home } = makeRepo();
    const origin = join(root, "origin.git");
    git(root, "init", "-q", "--bare", origin);
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-q", "origin", "master");
    const sha = featureCommit(repo, "feat-p", "p.txt", "p\n");
    queueEntry(home, repo, "p", "feat-p", sha, "p.txt", "2026-01-01T00:00:00Z");

    const opened: string[] = [];
    const res = await deliverPending({
      home, now: "t", defaultBranch: "master",
      repoPolicy: () => ({ mode: "pr" as DeliveryMode, defaultBranch: "master" }),
      openPr: async (_cwd, branch, title, base) => { opened.push(`${branch}|${base}|${title}`); return "https://example.test/pr/1"; },
    });

    expect(res[0]!.outcome).toBe("delivered");
    expect(res[0]!.pr_url).toBe("https://example.test/pr/1");
    expect(opened[0]!.startsWith("orch/deliver-")).toBe(true);
    expect(git(origin, "branch", "--list", "orch/deliver-*")).toContain("orch/deliver-");
    expect(git(repo, "rev-parse", "master")).not.toBe(sha);
  });
});

describe("delivery supervisor: grouping and overlap refusal", () => {
  test("second entry touching the same file is refused, first is delivered", async () => {
    const { repo, home } = makeRepo();
    const s1 = featureCommit(repo, "feat-1", "shared.txt", "one\n");
    const s2 = featureCommit(repo, "feat-2", "shared.txt", "two\n");
    queueEntry(home, repo, "one", "feat-1", s1, "shared.txt", "2026-01-01T00:00:01Z");
    queueEntry(home, repo, "two", "feat-2", s2, "shared.txt", "2026-01-01T00:00:02Z");

    const res = await deliverPending({ home, now: "t", defaultBranch: "master", repoPolicy: () => ({ mode: "direct", defaultBranch: "master" }) });

    expect(res).toHaveLength(1);
    expect(res[0]!.entries).toEqual([entryKey("r1", "one")]);
    expect(readFileSync(join(repo, "shared.txt"), "utf8")).toBe("one\n");
    const q = loadQueue(home);
    expect(q.entries[entryKey("r1", "two")]?.state).toBe("refused");
  });
});

describe("delivery supervisor: resume after restart", () => {
  test("a rerun after delivery does nothing; a reset entry re-applies without duplicating the commit", async () => {
    const { repo, home } = makeRepo();
    const sha = featureCommit(repo, "feat-r", "r.txt", "r\n");
    queueEntry(home, repo, "r", "feat-r", sha, "r.txt", "2026-01-01T00:00:00Z");
    const policy = () => ({ mode: "direct" as DeliveryMode, defaultBranch: "master" });

    await deliverPending({ home, now: "t", defaultBranch: "master", repoPolicy: policy });
    const countAfterFirst = Number(git(repo, "rev-list", "--count", "master"));
    expect(await deliverPending({ home, now: "t", defaultBranch: "master", repoPolicy: policy })).toHaveLength(0);

    // Simulate a restart that lost the delivered mark: the commit must not be applied twice.
    const q = loadQueue(home);
    q.entries[entryKey("r1", "r")] = { ...q.entries[entryKey("r1", "r")]!, state: "queued" };
    saveQueue(home, q);
    await deliverPending({ home, now: "t", defaultBranch: "master", repoPolicy: policy });
    expect(Number(git(repo, "rev-list", "--count", "master"))).toBe(countAfterFirst);
  });
});
