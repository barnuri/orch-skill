import { describe, expect, test } from "bun:test";
import type { RunNode } from "../../shared/types/run-node";
import { ownerChip, ownerStateLabel } from "./node-flags";

const base = { id: "n1", status: "running" } as RunNode;

describe("owner unknown, unbound and no owner", () => {
  test("unknown shows the exact owner_state and owner_reason", () => {
    const n = { ...base, owner: "ses_a", owner_state: "unknown", owner_reason: "session listing failed" } as RunNode;
    expect(ownerChip(n)).toEqual({ cls: "waiting", text: "owner_state: unknown, owner_reason: session listing failed", title: "session listing failed" });
    expect(ownerStateLabel(n)).toBe("owner_state: unknown, owner_reason: session listing failed");
  });

  test("unknown with no owner text still shows the exact state, not no owner", () => {
    const n = { ...base, owner_state: "unknown", owner_reason: "session listing failed" } as RunNode;
    expect(ownerChip(n)?.text).toBe("owner_state: unknown, owner_reason: session listing failed");
    expect(ownerStateLabel(n)).toBe("owner_state: unknown, owner_reason: session listing failed");
  });

  test("unbound shows the exact owner_state and owner_reason", () => {
    const n = { ...base, owner: "agent (spawned)", owner_state: "unbound", owner_reason: "tie on title between ses_1, ses_2" } as RunNode;
    expect(ownerChip(n)).toEqual({ cls: "waiting", text: "owner_state: unbound, owner_reason: tie on title between ses_1, ses_2", title: "tie on title between ses_1, ses_2" });
    expect(ownerStateLabel(n)).toBe("owner_state: unbound, owner_reason: tie on title between ses_1, ses_2");
  });

  test("no owner is its own label, not unknown or unbound", () => {
    const n = { ...base } as RunNode;
    expect(ownerChip(n)).toEqual({ cls: "waiting", text: "no owner", title: "Nothing is recorded as doing the work" });
    expect(ownerStateLabel(n)).toBe("no owner");
  });

  test("a recorded owner with no state yet is not checked, not unknown", () => {
    const n = { ...base, owner: "ses_a" } as RunNode;
    expect(ownerChip(n)?.text).toBe("owner not checked");
    expect(ownerStateLabel(n)).toBe("owner not checked");
  });

  test("a job-owned node with no owner text is not 'no owner'", () => {
    const n = { ...base, job_id: "job-1" } as RunNode;
    expect(ownerChip(n)).toBeNull();
  });

  test("the four states never share a label", () => {
    const labels = [
      ownerChip({ ...base, owner: "ses_a", owner_state: "unknown", owner_reason: "r" } as RunNode)?.text,
      ownerChip({ ...base, owner: "x", owner_state: "unbound", owner_reason: "r" } as RunNode)?.text,
      ownerChip({ ...base } as RunNode)?.text,
      ownerChip({ ...base, owner: "ses_a", owner_state: "alive" } as RunNode)?.text,
    ];
    expect(new Set(labels).size).toBe(4);
  });

  test("a missing reason is said outright, not filled with a guess", () => {
    expect(ownerChip({ ...base, owner: "ses_a", owner_state: "unknown" } as RunNode)?.title).toBe("owner_reason not recorded");
    expect(ownerChip({ ...base, owner: "x", owner_state: "unbound" } as RunNode)?.title).toBe("owner_reason not recorded");
    expect(ownerStateLabel({ ...base, owner: "x", owner_state: "unbound" } as RunNode)).toBe("owner_state: unbound");
  });
});
