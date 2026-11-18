import { describe, expect, test } from "bun:test";
import type { FeedbackItem } from "../../shared/types/feedback";
import { actionsFor, filterByStatus, linkFor, newIds, pruneSelection, sortNewestFirst, workRunStatus, workSummary } from "./feedback-logic";

function item(over: Partial<FeedbackItem> & { id: string }): FeedbackItem {
  return { text: "t", source: "ui", kind: "other", status: "new", created: "2026-11-17T10:00:00Z", updated: "2026-11-17T10:00:00Z", ...over };
}

describe("feedback row actions", () => {
  test("new offers queue and wontfix; queued and working offer wontfix; done and wontfix offer reopen", () => {
    expect(actionsFor("new").map((a) => a.action)).toEqual(["queue", "wontfix"]);
    expect(actionsFor("queued").map((a) => a.action)).toEqual(["wontfix"]);
    expect(actionsFor("working").map((a) => a.action)).toEqual(["wontfix"]);
    expect(actionsFor("done")).toEqual([{ action: "reopen", target: "new", label: "Reopen" }]);
    expect(actionsFor("wontfix")).toEqual([{ action: "reopen", target: "new", label: "Reopen" }]);
  });

  test("queue moves a new item to queued", () => {
    expect(actionsFor("new")[0]).toEqual({ action: "queue", target: "queued", label: "Queue" });
  });
});

describe("sortNewestFirst", () => {
  test("orders by created time, newest first, then by id descending", () => {
    const sorted = sortNewestFirst([
      item({ id: "fb-20261117-1", created: "2026-11-17T09:00:00Z" }),
      item({ id: "fb-20261117-3", created: "2026-11-17T11:00:00Z" }),
      item({ id: "fb-20261117-2", created: "2026-11-17T11:00:00Z" }),
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["fb-20261117-3", "fb-20261117-2", "fb-20261117-1"]);
  });

  test("does not mutate its input", () => {
    const input = [item({ id: "fb-20261117-1", created: "2026-11-17T09:00:00Z" }), item({ id: "fb-20261117-2", created: "2026-11-17T11:00:00Z" })];
    sortNewestFirst(input);
    expect(input[0]?.id).toBe("fb-20261117-1");
  });
});

describe("filterByStatus and newIds", () => {
  const items = [item({ id: "a", status: "new" }), item({ id: "b", status: "done" }), item({ id: "c", status: "new" })];

  test("all keeps every item; a status keeps only that status", () => {
    expect(filterByStatus(items, "all")).toHaveLength(3);
    expect(filterByStatus(items, "done").map((i) => i.id)).toEqual(["b"]);
  });

  test("newIds lists only new items", () => {
    expect(newIds(items)).toEqual(["a", "c"]);
  });
});

describe("pruneSelection", () => {
  test("drops selected ids that are no longer listed", () => {
    const kept = pruneSelection(new Set(["a", "gone"]), [item({ id: "a" })]);
    expect([...kept]).toEqual(["a"]);
  });
});

describe("linkFor", () => {
  test("a chat link wins over a run link; a bare item has none", () => {
    expect(linkFor(item({ id: "a", chat_id: "chat-1", run_id: "r1" }))).toEqual({ href: "#/chats/chat-1", label: "chat chat-1" });
    expect(linkFor(item({ id: "a", run_id: "r 1" }))).toEqual({ href: "#/run/r%201", label: "run r 1" });
    expect(linkFor(item({ id: "a" }))).toBeNull();
  });
});

describe("workRunStatus and workSummary", () => {
  test("reads the status of the item's work run from the loaded runs", () => {
    const statuses = new Map([["feedback-batch-1", "running"]]);
    expect(workRunStatus(item({ id: "a", work_run: "feedback-batch-1" }), statuses)).toBe("running");
    expect(workRunStatus(item({ id: "a", work_run: "unknown" }), statuses)).toBeNull();
    expect(workRunStatus(item({ id: "a" }), statuses)).toBeNull();
  });

  test("summarizes the start result", () => {
    expect(workSummary(2, "feedback-batch-1")).toBe("Started 2 item(s) in run feedback-batch-1");
    expect(workSummary(0, null)).toBe("No new feedback to work on");
  });
});
