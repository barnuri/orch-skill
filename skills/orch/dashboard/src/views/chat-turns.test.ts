import { describe, expect, test } from "bun:test";

import type { ChatTurn } from "../../../shared/types/chat-turn";
import { orderedForDisplay } from "./chat-turns.ts";

function turn(id: string): ChatTurn {
  return { id, role: "user", timestamp: null, text: id, tools: [] };
}

describe("orderedForDisplay", () => {
  test("puts the newest turn first", () => {
    const chronological = [turn("first"), turn("second"), turn("third")];
    expect(orderedForDisplay(chronological).map((item) => item.id)).toEqual([
      "third",
      "second",
      "first",
    ]);
  });

  test("leaves the caller's array untouched", () => {
    const chronological = [turn("first"), turn("second")];
    orderedForDisplay(chronological);
    expect(chronological.map((item) => item.id)).toEqual(["first", "second"]);
  });

  test("an empty transcript orders to empty", () => {
    expect(orderedForDisplay([])).toEqual([]);
  });
});
