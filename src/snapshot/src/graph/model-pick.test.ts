import { describe, expect, test } from "bun:test";

import type { RunNode } from "../../../shared/types/run-node";
import { modelPick, pickLabel } from "./model-pick";

describe("modelPick", () => {
  test("pinned profile model beats the hub expected guess", () => {
    const pick = modelPick(
      node({
        model_id: "hub/claude-haiku-5-5",
        hub: { expected: { model: "copilot/claude-opus-5-5", tier: "efficiency", role: "validation", reason: "fresh" } },
      }),
    );
    expect(pick?.model).toBe("hub/claude-haiku-5-5");
    expect(pick?.short).toBe("claude-haiku-5-5");
    expect(pick?.isExpected).toBe(false);
    expect(pick?.isAuto).toBe(false);
  });

  test("Smart Auto selector with only hub expected shows the expected model", () => {
    const pick = modelPick(
      node({
        model_id: "hub-smart-auto-balance",
        hub: { expected: { model: "copilot/claude-opus-5-5", tier: "pro", role: "solver", reason: "fresh" } },
      }),
    );
    expect(pick?.model).toBe("copilot/claude-opus-5-5");
    expect(pick?.short).toBe("claude-opus-5-5");
    expect(pick?.isExpected).toBe(true);
    expect(pick?.isAuto).toBe(true);
    expect(pick?.selector).toBe("hub-smart-auto-balance");
    expect(pickLabel(pick!)).toBe("~claude-opus-5-5");
  });

  test("hub actual wins over hub expected", () => {
    const pick = modelPick(
      node({
        model_id: "hub-smart-auto-balance",
        hub: {
          expected: { model: "copilot/claude-opus-5-5" },
          actual: { model: "copilot/gpt-5.6-luna", tier: "efficiency", role: "solver", reason: "served" },
        },
      }),
    );
    expect(pick?.model).toBe("copilot/gpt-5.6-luna");
    expect(pick?.short).toBe("gpt-5.6-luna");
    expect(pick?.isExpected).toBe(false);
    expect(pick?.tier).toBe("efficiency");
  });
});

function node(extra: Record<string, unknown>): RunNode {
  return { id: "n", label: "n", status: "running", ...extra } as unknown as RunNode;
}
