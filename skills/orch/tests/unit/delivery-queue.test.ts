import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deliveryMode, emptyQueue, enqueue, entryKey, groupQueue, loadQueue, saveQueue, type DeliveryQueue } from "../../core/delivery/queue.ts";

const item = (node: string, repo: string, touched: string[], t: string) => ({
  run: "r1", node, repo, branch: "master", worktree: repo, commits: [`c-${node}`], touched, enqueued_at: t,
});

function build(...inputs: ReturnType<typeof item>[]): DeliveryQueue {
  let q = emptyQueue();
  for (const i of inputs) q = enqueue(q, i, i.enqueued_at).queue;
  return q;
}

const direct = () => "direct" as const;

describe("delivery queue: enqueue", () => {
  test("is idempotent by run/node key", () => {
    const first = enqueue(emptyQueue(), item("a", "/r/private/x", ["a.ts"], "t1"), "t1");
    const again = enqueue(first.queue, item("a", "/r/private/x", ["other.ts"], "t2"), "t2");
    expect(again.added).toBe(false);
    expect(Object.keys(again.queue.entries)).toEqual([entryKey("r1", "a")]);
    expect(again.entry.touched).toEqual(["a.ts"]);
  });

  test("persists atomically and reloads after a restart", () => {
    const home = mkdtempSync(join(tmpdir(), "delivery-"));
    saveQueue(home, build(item("a", "/r/private/x", ["a.ts"], "t1")));
    const reloaded = loadQueue(home);
    expect(reloaded.entries[entryKey("r1", "a")]?.commits).toEqual(["c-a"]);
    expect(loadQueue(mkdtempSync(join(tmpdir(), "empty-")))).toEqual(emptyQueue());
  });
});

describe("delivery queue: grouping", () => {
  test("groups compatible entries of one repo into one group", () => {
    const q = build(item("a", "/r/private/x", ["a.ts"], "t1"), item("b", "/r/private/x", ["b.ts"], "t2"));
    const { queue, groups } = groupQueue(q, direct);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.entries).toEqual([entryKey("r1", "a"), entryKey("r1", "b")]);
    expect(groups[0]!.touched).toEqual(["a.ts", "b.ts"]);
    expect(queue.entries[entryKey("r1", "b")]?.state).toBe("grouped");
  });

  test("keeps repos apart", () => {
    const q = build(item("a", "/r/private/x", ["a.ts"], "t1"), item("b", "/r/private/y", ["a.ts"], "t2"));
    const { groups } = groupQueue(q, direct);
    expect(groups.map((g) => g.repo).sort()).toEqual(["/r/private/x", "/r/private/y"]);
  });
});

describe("delivery queue: overlap refusal", () => {
  test("refuses an entry that shares a file with the group and never merges it", () => {
    const q = build(item("a", "/r/private/x", ["shared.ts"], "t1"), item("b", "/r/private/x", ["shared.ts", "b.ts"], "t2"));
    const { queue, groups } = groupQueue(q, direct);
    const b = queue.entries[entryKey("r1", "b")]!;
    expect(b.state).toBe("refused");
    expect(b.group).toBeNull();
    expect(b.refused_reason).toContain("shared.ts");
    expect(groups[0]!.entries).toEqual([entryKey("r1", "a")]);
    expect(groups[0]!.touched).not.toContain("b.ts");
  });

  test("grouping is deterministic when rebuilt after a restart", () => {
    const q = build(item("a", "/r/private/x", ["s.ts"], "t1"), item("b", "/r/private/x", ["s.ts"], "t2"));
    const once = groupQueue(q, direct).queue;
    const twice = groupQueue(once, direct).queue;
    expect(twice).toEqual(once);
  });
});

describe("delivery queue: repo policy", () => {
  test("private repo without a PR rule commits directly", () => {
    expect(deliveryMode("/Users/me/sandbox/private/orch", "Run tests before commit.")).toBe("direct");
  });
  test("a PR rule in the repo instructions forces a PR", () => {
    expect(deliveryMode("/Users/me/sandbox/private/orch", "All changes go through a pull request.")).toBe("pr");
  });
  test("a non-private repo goes through a PR", () => {
    expect(deliveryMode("/Users/me/sandbox/CP/app", "")).toBe("pr");
  });
});
