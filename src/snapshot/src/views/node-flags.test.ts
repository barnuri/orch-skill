import { describe, expect, test } from "bun:test";

import type { RunNode } from "../../../shared/types/run-node";
import { healthClass, needsUserReason, nodeFlags, ownerText } from "./node-flags";
import { describeEvent } from "./run-activity";

const base = { id: "n", label: "n", status: "running", job_id: null } as unknown as RunNode;

test("running with no owner and no job is unowned", () => {
  expect(nodeFlags(base).unowned).toBe(true);
  expect(nodeFlags({ ...base, owner: "coordinator" }).unowned).toBe(false);
  expect(nodeFlags({ ...base, job_id: "job-1" }).unowned).toBe(false);
});

test("stale and after-the-fact flags", () => {
  expect(nodeFlags({ ...base, stale: true }).stale).toBe(true);
  expect(nodeFlags({ ...base, status: "done", backfilled: true } as RunNode).afterTheFact).toBe(true);
});

test("owner text names the kind of owner", () => {
  expect(ownerText({ ...base, owner: "ses_abc" })).toBe("agent ses_abc");
  expect(ownerText({ ...base, owner: "job-123" })).toBe("job job-123");
  expect(ownerText({ ...base, owner: "coordinator" })).toBe("coordinator");
  expect(ownerText(base)).toBeNull();
});

test("events read as changes", () => {
  const e = { n: 1, at: "x", kind: "status", node: "n", from: "running", to: "done", note: null, by: null };
  expect(describeEvent(e)).toBe("running → done");
});

test("health line tone: a live owner is not a warning", () => {
  expect(healthClass({ ...base, owner: "ses_a", owner_state: "alive" } as RunNode)).toBe("health running");
  expect(healthClass({ ...base, owner: "ses_a", owner_state: "alive", stale: true } as RunNode)).toBe("health flagged");
  expect(healthClass(base)).toBe("health flagged");
  expect(healthClass({ ...base, status: "error", owner: "ses_a", owner_state: "gone" } as RunNode)).toBe("health error");
  expect(healthClass({ ...base, owner: "coordinator" })).toBe("health");
});

test("needs-user reason: trimmed text, null when absent or blank", () => {
  expect(needsUserReason({ ...base, status: "waiting", needs_user: " check on your phone " } as RunNode)).toBe("check on your phone");
  expect(needsUserReason({ ...base, needs_user: "" } as RunNode)).toBeNull();
  expect(needsUserReason({ ...base, needs_user: null } as RunNode)).toBeNull();
  expect(needsUserReason(base)).toBeNull();
});

import { resultChip } from "./node-flags";
describe("resultChip", () => {
  test("verdict, unknown for done without result, null otherwise", () => {
    expect(resultChip({ status: "done", result: { verdict: "partial", summary: "s", follow_up: "f", at: "" } } as never)?.verdict).toBe("partial");
    expect(resultChip({ status: "done" } as never)?.verdict).toBe("unknown");
    expect(resultChip({ status: "running" } as never)).toBeNull();
  });
});
