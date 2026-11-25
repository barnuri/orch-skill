import { describe, expect, test } from "bun:test";
import { applyRunPatch, diffRun } from "./run-patch";

const base = { run_id: "r", status: "running", edges: [["a", "b"]], nodes: [{ id: "a", status: "running", x: 1 }, { id: "b", status: "waiting" }] };

describe("run patch", () => {
  test("no change gives null", () => {
    expect(diffRun("r", base, structuredClone(base))).toBeNull();
  });
  test("only the changed node fields travel, and apply restores the run", () => {
    const next = { ...structuredClone(base), nodes: [{ id: "a", status: "done" }, { id: "b", status: "waiting" }, { id: "c", status: "waiting" }] };
    const patch = diffRun("r", base, next);
    expect(patch?.nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(patch?.nodes[0]).toEqual({ id: "a", changed: { status: "done" }, unset: ["x"] });
    expect(applyRunPatch(base, patch!)).toEqual(next);
  });
  test("removed nodes, null values, top fields and edges", () => {
    const next = { run_id: "r", status: "done", edges: [], note: null, nodes: [{ id: "b", status: "waiting", y: null }] };
    const patch = diffRun("r", base, next)!;
    expect(patch.removed).toEqual(["a"]);
    expect(applyRunPatch(base, patch)).toEqual(next);
  });
});
