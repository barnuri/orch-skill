// test-tier: slow (each turn runs the real dispatch.sh)
import { describe, expect, test } from "bun:test";

import { chatRow, installChatResumeCleanup, REAL_DISPATCH, REAL_TURN_TIMEOUT_MS, say, setup } from "./testing/chat-resume-support";

installChatResumeCleanup();

// pi has no lost-session test: `--session-id` creates a missing session, so an id can never be lost there.
describe("memory across 3 turns, one session per chat", () => {
  test("pi: the harness session grows each turn and its id is stored", async () => {
    const { service } = setup(REAL_DISPATCH);
    const chat = service.createChat({ title: "t", harness: "pi", profile: "pi" });
    const replies: string[] = [];
    for (const text of ["one", "two", "three"]) {
      const m = await say(service, chat.id, text);
      expect(m.error).toBeNull();
      expect(m.warning).toBeNull();
      replies.push(m.content);
    }
    expect(replies).toEqual(["turns=1", "turns=2", "turns=3"]);
    expect(chatRow(service, chat.id).session_id).not.toBeNull();
  }, REAL_TURN_TIMEOUT_MS);
});
