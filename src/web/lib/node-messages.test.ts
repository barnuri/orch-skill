import { describe, expect, test } from "bun:test";

import type { RunMessage } from "../../shared/types/run-message";
import { canMessage, messageLine, nodeThread, openAsks } from "./node-messages";

function msg(seq: number, fields: Partial<RunMessage>): RunMessage {
  return {
    id: `m${seq}`, seq, from: "user", to: "a", kind: "tell", at: "2026-11-15T12:00:00Z", text: `t${seq}`,
    status: "pending", delivered_at: null, via: null, ...fields,
  };
}

const MESSAGES: RunMessage[] = [
  msg(1, { from: "a", to: "orch", kind: "ask", text: "which db?", answer: "postgres", answered_at: "x" }),
  msg(2, { from: "a", to: "orch", kind: "ask", text: "which port?", answer: null }),
  msg(3, { from: "b", to: "orch", kind: "ask", text: "b asks", answer: null }),
  msg(4, { to: "a", kind: "answer", text: "Answer to m1: postgres", reply_to: "m1", status: "delivered" }),
  msg(5, { to: "b", text: "for b" }),
];

describe("node messages", () => {
  test("openAsks keeps only the node's unanswered asks", () => {
    expect(openAsks(MESSAGES, "a").map((m) => m.id)).toEqual(["m2"]);
    expect(openAsks(MESSAGES, "b").map((m) => m.id)).toEqual(["m3"]);
    expect(openAsks(MESSAGES, "c")).toEqual([]);
  });

  test("nodeThread keeps messages to or from the node, newest last, capped", () => {
    expect(nodeThread(MESSAGES, "a").map((m) => m.id)).toEqual(["m1", "m2", "m4"]);
    expect(nodeThread(MESSAGES, "a", 2).map((m) => m.id)).toEqual(["m2", "m4"]);
  });

  test("messageLine shows the direction, the answer and a non-delivered state", () => {
    expect(messageLine(MESSAGES[0]!)).toBe("a asks: which db? (answered: postgres)");
    expect(messageLine(MESSAGES[3]!)).toBe("user → a: Answer to m1: postgres");
    expect(messageLine(MESSAGES[4]!)).toBe("user → b: for b (pending)");
  });

  test("only running and waiting nodes take messages", () => {
    expect(["running", "waiting", "done", "error", "skipped"].map(canMessage)).toEqual([true, true, false, false, false]);
  });
});
