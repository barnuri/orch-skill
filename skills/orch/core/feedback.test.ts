import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addFeedback, applyPatch, buildFeedback, dayStamp, filterFeedback, getFeedback,
  nextFeedbackId, readFeedback, updateFeedback, type FeedbackItem,
} from "./feedback.ts";

const NOW = "2026-11-17T10:00:00Z";

describe("feedback ids", () => {
  test("day stamp is yyyymmdd UTC", () => {
    expect(dayStamp(NOW)).toBe("20261117");
  });
  test("first id of the day is n=1", () => {
    expect(nextFeedbackId([], NOW)).toBe("fb-20261117-1");
  });
  test("next id follows the highest n of the same day, ignoring other days", () => {
    expect(nextFeedbackId(["fb-20261117-1", "fb-20261117-3", "fb-20261116-9"], NOW)).toBe("fb-20261117-4");
  });
});

describe("buildFeedback", () => {
  test("defaults kind to other and status to new", () => {
    const i = buildFeedback({ text: " slow chip ", source: "cli" }, "fb-20261117-1", NOW);
    expect(i).toEqual({ id: "fb-20261117-1", text: "slow chip", source: "cli", kind: "other", status: "new", created: NOW, updated: NOW });
  });
  test("keeps optional refs only when given", () => {
    const i = buildFeedback({ text: "x", source: "chat", kind: "bug", chat_id: "c1", run_id: "r1", node_id: "n1" }, "fb-20261117-2", NOW);
    expect(i.chat_id).toBe("c1");
    expect(i.run_id).toBe("r1");
    expect(i.node_id).toBe("n1");
    expect(i.kind).toBe("bug");
  });
  test("rejects empty text, bad source and bad kind", () => {
    expect(() => buildFeedback({ text: "   ", source: "cli" }, "fb-20261117-1", NOW)).toThrow("empty");
    expect(() => buildFeedback({ text: "x", source: "email" as any }, "fb-20261117-1", NOW)).toThrow("bad source");
    expect(() => buildFeedback({ text: "x", source: "cli", kind: "praise" as any }, "fb-20261117-1", NOW)).toThrow("bad kind");
  });
});

describe("applyPatch", () => {
  const base: FeedbackItem = buildFeedback({ text: "x", source: "ui" }, "fb-20261117-1", NOW);
  test("sets status, result and work_run and bumps updated", () => {
    const later = "2026-11-17T11:00:00Z";
    const p = applyPatch(base, { status: "done", result: "fixed", work_run: "r9" }, later);
    expect(p.status).toBe("done");
    expect(p.result).toBe("fixed");
    expect(p.work_run).toBe("r9");
    expect(p.updated).toBe(later);
    expect(base.status).toBe("new");
  });
  test("rejects an unknown status", () => {
    expect(() => applyPatch(base, { status: "closed" as any }, NOW)).toThrow("bad status");
  });
});

describe("filterFeedback", () => {
  const mk = (id: string, status: FeedbackItem["status"], created: string): FeedbackItem =>
    ({ ...buildFeedback({ text: id, source: "cli" }, id, created), status });
  const items = [mk("fb-20261117-2", "new", "2026-11-17T12:00:00Z"), mk("fb-20261117-1", "done", NOW), mk("fb-20261117-3", "new", "2026-11-17T13:00:00Z")];
  test("sorts by created, filters by status and ids", () => {
    expect(filterFeedback(items, {}).map((i) => i.id)).toEqual(["fb-20261117-1", "fb-20261117-2", "fb-20261117-3"]);
    expect(filterFeedback(items, { status: "new" }).map((i) => i.id)).toEqual(["fb-20261117-2", "fb-20261117-3"]);
    expect(filterFeedback(items, { ids: ["fb-20261117-3"] }).map((i) => i.id)).toEqual(["fb-20261117-3"]);
  });
});

describe("store", () => {
  test("add, read, show and update round-trip through <home>/feedback", () => {
    const home = mkdtempSync(join(tmpdir(), "fb-store-"));
    const a = addFeedback(home, { text: "first", source: "cli" }, NOW);
    const b = addFeedback(home, { text: "second", source: "chat", kind: "idea" }, NOW);
    expect(a.id).toBe("fb-20261117-1");
    expect(b.id).toBe("fb-20261117-2");
    expect(readFeedback(home).length).toBe(2);
    expect(getFeedback(home, "fb-20261117-2")?.kind).toBe("idea");
    expect(getFeedback(home, "fb-20261117-99")).toBeNull();
    expect(() => getFeedback(home, "fb-nope")).toThrow("bad feedback id");
    const u = updateFeedback(home, "fb-20261117-1", { status: "queued", work_run: "r1" }, NOW);
    expect(u.status).toBe("queued");
    expect(getFeedback(home, "fb-20261117-1")?.work_run).toBe("r1");
  });
  test("update of a missing id throws", () => {
    const home = mkdtempSync(join(tmpdir(), "fb-store-"));
    expect(() => updateFeedback(home, "fb-20261117-9", { status: "done" }, NOW)).toThrow("no feedback");
  });
  test("ids outside the fb-yyyymmdd-n form are rejected before any file access", () => {
    const home = mkdtempSync(join(tmpdir(), "fb-store-"));
    expect(() => getFeedback(home, "../x")).toThrow("bad feedback id");
    expect(() => updateFeedback(home, "../x", { status: "done" }, NOW)).toThrow("bad feedback id");
  });
  test("a corrupt file is skipped by the list and does not block a new add", () => {
    const home = mkdtempSync(join(tmpdir(), "fb-store-"));
    addFeedback(home, { text: "ok", source: "cli" }, NOW);
    const dir = join(home, "feedback");
    require("node:fs").writeFileSync(join(dir, "fb-20261117-5.json"), "{not json");
    expect(readFeedback(home).map((i) => i.id)).toEqual(["fb-20261117-1"]);
    expect(addFeedback(home, { text: "next", source: "cli" }, NOW).id).toBe("fb-20261117-2");
  });
  test("add does not overwrite a file another writer created after the list was read", () => {
    const home = mkdtempSync(join(tmpdir(), "fb-store-"));
    const dir = join(home, "feedback");
    require("node:fs").mkdirSync(dir, { recursive: true });
    // Unreadable to readFeedback, so the id picker still offers n=1; the wx create must refuse it.
    require("node:fs").writeFileSync(join(dir, "fb-20261117-1.json"), "{not json");
    const added = addFeedback(home, { text: "race", source: "cli" }, NOW);
    expect(added.id).toBe("fb-20261117-2");
    expect(require("node:fs").readFileSync(join(dir, "fb-20261117-1.json"), "utf8")).toBe("{not json");
  });
});
