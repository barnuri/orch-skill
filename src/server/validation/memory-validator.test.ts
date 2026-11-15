import { describe, expect, test } from "bun:test";

import type { Issue } from "../../shared/types/issue";
import type { MemoryEntry } from "../../shared/types/memory-entry";
import { memoryIssues } from "./memory-validator";
import { MAX_MEMORY_ENTRIES } from "./rules";

const OUTCOMES: readonly string[] = ["success", "failure", "partial"];

function validEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    ts: "2026-09-03T10:15:00Z",
    task_kind: "refactor",
    profile: "default",
    harness: "claude",
    model: "opus",
    outcome: "success",
    note: "went fine",
    ...overrides,
  };
}

function paths(issues: Issue[]): string[] {
  return issues.map((issue) => issue.path);
}

describe("memoryIssues", () => {
  test("empty list is valid", () => {
    expect(memoryIssues([], OUTCOMES)).toEqual([]);
  });

  test("a fully populated valid entry has no issues", () => {
    expect(memoryIssues([validEntry()], OUTCOMES)).toEqual([]);
  });

  test("an entry with only the required keys is valid", () => {
    const entry = { ts: "2026-09-03T10:15:00Z", profile: "default", outcome: "partial" };
    expect(memoryIssues([entry], OUTCOMES)).toEqual([]);
  });

  test("object root is rejected at $", () => {
    expect(memoryIssues({}, OUTCOMES)).toEqual([{ path: "$", reason: "must be an array" }]);
  });

  test("null and string roots are rejected at $", () => {
    expect(paths(memoryIssues(null, OUTCOMES))).toEqual(["$"]);
    expect(paths(memoryIssues("[]", OUTCOMES))).toEqual(["$"]);
  });

  test("outcome outside the enum names the entry field", () => {
    const issues = memoryIssues([validEntry({ outcome: "meh" })], OUTCOMES);
    expect(issues).toEqual([
      { path: "memory[0].outcome", reason: "must be one of success, failure, partial" },
    ]);
  });

  test("missing profile is reported as required", () => {
    const { profile: _profile, ...entry } = validEntry();
    expect(memoryIssues([entry], OUTCOMES)).toEqual([
      { path: "memory[0].profile", reason: "required" },
    ]);
  });

  test("unknown key is reported with its name", () => {
    const entry = { ...validEntry(), extra: "x" };
    expect(memoryIssues([entry], OUTCOMES)).toEqual([
      { path: "memory[0].extra", reason: "unknown key" },
    ]);
  });

  test("ts must match the UTC second-precision format", () => {
    for (const ts of ["2026-09-03", "2026-09-03T10:15:00", "2026-09-03T10:15:00.000Z", "now"]) {
      expect(paths(memoryIssues([validEntry({ ts })], OUTCOMES))).toEqual(["memory[0].ts"]);
    }
  });

  test("empty profile is rejected", () => {
    expect(memoryIssues([validEntry({ profile: "" })], OUTCOMES)).toEqual([
      { path: "memory[0].profile", reason: "must not be empty" },
    ]);
  });

  test("multi-line note is allowed", () => {
    const note = "line one\nline two\n\ttabbed";
    expect(memoryIssues([validEntry({ note })], OUTCOMES)).toEqual([]);
  });

  test("non-string values are rejected per field", () => {
    const entry = { ...validEntry(), note: 3, model: null };
    expect(paths(memoryIssues([entry], OUTCOMES)).sort()).toEqual([
      "memory[0].model",
      "memory[0].note",
    ]);
  });

  test("non-object entries are rejected without inspecting fields", () => {
    const issues = memoryIssues([validEntry(), "text", null, [], 7], OUTCOMES);
    expect(issues).toEqual([
      { path: "memory[1]", reason: "must be an object" },
      { path: "memory[2]", reason: "must be an object" },
      { path: "memory[3]", reason: "must be an object" },
      { path: "memory[4]", reason: "must be an object" },
    ]);
  });

  test("all issues across entries are collected", () => {
    const issues = memoryIssues(
      [validEntry({ outcome: "meh" }), { ts: "bad" }, validEntry()],
      OUTCOMES,
    );
    expect(paths(issues)).toEqual([
      "memory[0].outcome",
      "memory[1].profile",
      "memory[1].outcome",
      "memory[1].ts",
    ]);
  });

  test("exactly the maximum number of entries is allowed", () => {
    const entries = Array.from({ length: MAX_MEMORY_ENTRIES }, () => validEntry());
    expect(memoryIssues(entries, OUTCOMES)).toEqual([]);
  });

  test("one entry over the maximum is rejected at $", () => {
    const entries = Array.from({ length: MAX_MEMORY_ENTRIES + 1 }, () => validEntry());
    expect(memoryIssues(entries, OUTCOMES)).toEqual([
      { path: "$", reason: `at most ${MAX_MEMORY_ENTRIES} entries` },
    ]);
  });
});
