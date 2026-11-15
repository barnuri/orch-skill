import { expect, test } from "bun:test";

import type { RunNode } from "../../../shared/types/run-node";
import { nodeFlags, ownerText } from "./node-flags";
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
