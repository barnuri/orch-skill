import { expect, test } from "bun:test";

import type { RunNode } from "../../shared/types/run-node";
import { healthClass, needsUserReason, resultChip } from "./node-flags";

const base = { id: "n", label: "n", status: "running", job_id: null } as unknown as RunNode;

test("health line tone: alive is blue, stalled amber, idle grey, gone red", () => {
  expect(healthClass({ ...base, owner: "ses_a", owner_state: "alive" } as RunNode)).toBe("health running");
  expect(healthClass({ ...base, owner: "ses_a", owner_state: "alive", stalled: true } as RunNode)).toBe("health flagged");
  expect(healthClass({ ...base, owner: "ses_a", owner_state: "idle" } as RunNode)).toBe("health waiting");
  expect(healthClass({ ...base, status: "error", owner: "ses_a", owner_state: "gone" } as RunNode)).toBe("health error");
  expect(healthClass(base)).toBe("health flagged");
  expect(healthClass({ ...base, status: "done", backfilled: true } as RunNode)).toBe("health flagged");
  expect(healthClass({ ...base, owner: "coordinator" } as RunNode)).toBe("health");
});

test("needs-user reason: trimmed text, null when absent or blank", () => {
  expect(needsUserReason({ ...base, status: "waiting", needs_user: " check on your phone " } as RunNode)).toBe("check on your phone");
  expect(needsUserReason({ ...base, needs_user: "" } as RunNode)).toBeNull();
  expect(needsUserReason({ ...base, needs_user: null } as RunNode)).toBeNull();
  expect(needsUserReason(base)).toBeNull();
});

test("resultChip tolerates a result with null summary or follow_up", () => {
  const chip = resultChip({ id: "a", status: "done", result: { verdict: "full", summary: null, follow_up: null } } as never);
  expect(chip).toEqual({ verdict: "full", summary: "", followUp: "" });
});
