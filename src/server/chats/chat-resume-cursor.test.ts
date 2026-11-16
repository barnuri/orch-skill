// test-tier: slow (each turn runs the real dispatch.sh)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chatRow, installChatResumeCleanup, REAL_DISPATCH, REAL_TURN_TIMEOUT_MS, say, setup, trash } from "./testing/chat-resume-support";

installChatResumeCleanup();

describe("memory across 3 turns, one session per chat", () => {
  test("cursor-agent: the harness session grows each turn and its id is stored", async () => {
    const { service } = setup(REAL_DISPATCH);
    const chat = service.createChat({ title: "t", harness: "cursor-agent", profile: "cursor-agent" });
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

describe("a lost session falls back to a fresh one with a visible warning", () => {
  test("cursor-agent", async () => {
    const { service, state } = setup(REAL_DISPATCH);
    const chat = service.createChat({ title: "t", harness: "cursor-agent", profile: "cursor-agent" });
    await say(service, chat.id, "one");
    const first = chatRow(service, chat.id).session_id as string;
    trash(join(state, first));
    const m = await say(service, chat.id, "two");
    expect(m.status).toBe("done");
    expect(m.warning).toContain("could not be resumed");
    expect(chatRow(service, chat.id).session_id).not.toBe(first);
    expect(m.content).toBe("turns=1");
    expect(readFileSync(join(state, chatRow(service, chat.id).session_id as string), "utf8")).toContain("User: one");
    const next = await say(service, chat.id, "three");
    expect(next.warning).toBeNull();
    expect(next.content).toBe("turns=2");
  }, REAL_TURN_TIMEOUT_MS);
});

describe("failure to learn a session id", () => {
  test("cursor-agent without create-chat replays history with a warning", async () => {
    const { service } = setup(REAL_DISPATCH);
    process.env.FAKE_NO_CREATE_CHAT = "1";
    const chat = service.createChat({ title: "t", harness: "cursor-agent", profile: "cursor-agent" });
    await say(service, chat.id, "one");
    const m = await say(service, chat.id, "two");
    expect(m.warning).toContain("Could not create a cursor-agent chat");
    expect(m.error).toBeNull();
  }, REAL_TURN_TIMEOUT_MS);
});
