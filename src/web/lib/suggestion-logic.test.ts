import { expect, test } from "bun:test";
import { sortSuggestions } from "./suggestion-logic";

test("sortSuggestions tolerates entries without a created time", () => {
  const list = [
    { id: "a", status: "applied", kind: "orch-fix" },
    { id: "b", status: "applied", kind: "routing_hint", created: "2026-09-09T10:12:24Z" },
  ] as never;
  expect(sortSuggestions(list).map((s) => s.id)).toEqual(["b", "a"]);
});
