import { describe, expect, test } from "bun:test";

import { hasDataIslands, readDataIsland } from "./data-island.ts";
import { islandElementId } from "../../../shared/island-id.ts";
import type { IslandHost } from "./island-host.ts";

function hostWith(elements: Readonly<Record<string, string | null>>): IslandHost {
  return {
    getElementById: (elementId: string) =>
      elementId in elements ? { textContent: elements[elementId] ?? null } : null,
  };
}

describe("islandElementId", () => {
  test("namespaces the document name", () => {
    expect(islandElementId("runs")).toBe("orch-island-runs");
  });
});

describe("readDataIsland", () => {
  test("parses the island named after the document", () => {
    const host = hostWith({ "orch-island-runs": '{"runs":[{"run_id":"r1"}]}' });
    expect(readDataIsland<{ runs: { run_id: string }[] }>("runs", host)).toEqual({
      runs: [{ run_id: "r1" }],
    });
  });

  test("a missing island is null, not an error", () => {
    expect(readDataIsland("runs", hostWith({}))).toBeNull();
  });

  test("malformed JSON degrades to null", () => {
    const host = hostWith({ "orch-island-runs": "{not json" });
    expect(readDataIsland("runs", host)).toBeNull();
  });

  test("an empty or whitespace-only island is null", () => {
    expect(readDataIsland("runs", hostWith({ "orch-island-runs": "" }))).toBeNull();
    expect(readDataIsland("runs", hostWith({ "orch-island-runs": "   \n" }))).toBeNull();
  });

  test("an element with no text content is null", () => {
    expect(readDataIsland("runs", hostWith({ "orch-island-runs": null }))).toBeNull();
  });

  test("a run island is read by its id-suffixed name", () => {
    const host = hostWith({ "orch-island-run-20260915-120000-abcd": '{"run":{"run_id":"x"}}' });
    type RunIsland = { run: { run_id: string } };
    expect(readDataIsland<RunIsland>("run-20260915-120000-abcd", host)).toEqual({
      run: { run_id: "x" },
    });
    expect(readDataIsland<RunIsland>("run-other", host)).toBeNull();
  });

  test("JSON null in the island is returned as null", () => {
    expect(readDataIsland("runs", hostWith({ "orch-island-runs": "null" }))).toBeNull();
  });
});

describe("hasDataIslands", () => {
  test("true when any of the named islands is present", () => {
    const host = hostWith({ "orch-island-memory": "{}" });
    expect(hasDataIslands(["runs", "memory"], host)).toBe(true);
  });

  test("false on the live dashboard, where no island is embedded", () => {
    expect(hasDataIslands(["runs", "memory"], hostWith({}))).toBe(false);
  });

  test("false for an empty name list", () => {
    expect(hasDataIslands([], hostWith({ "orch-island-runs": "{}" }))).toBe(false);
  });
});
