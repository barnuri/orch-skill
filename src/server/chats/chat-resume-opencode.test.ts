// test-tier: slow (each turn runs the real dispatch.ts)
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { chatRow, installChatResumeCleanup, REAL_DISPATCH, REAL_TURN_TIMEOUT_MS, say, setup, trash } from "./testing/chat-resume-support";

installChatResumeCleanup();

describe("memory across 3 turns, one session per chat", () => {
  test("opencode: the harness session grows each turn and its id is stored", async () => {
    const { service } = setup(REAL_DISPATCH);
    const chat = service.createChat({ title: "t", harness: "opencode", profile: "opencode" });
    const replies: string[] = [];
    for (const text of ["one", "two", "three"]) {
      const m = await say(service, chat.id, text);
      expect(m.error).toBeNull();
      expect(m.warning).toBeNull();
      replies.push(m.content);
    }
    expect(replies).toEqual(["turns=1", "turns=2", "turns=3"]);
    expect(chatRow(service, chat.id).session_id).toMatch(/^ses_/);
  }, REAL_TURN_TIMEOUT_MS);
});

describe("a lost session falls back to a fresh one with a visible warning", () => {
  test("opencode", async () => {
    const { service, state } = setup(REAL_DISPATCH);
    const chat = service.createChat({ title: "t", harness: "opencode", profile: "opencode" });
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
  test("opencode without a readable session list replays history from the second turn", async () => {
    const { service, log } = setup(REAL_DISPATCH);
    process.env.FAKE_NO_SESSION_LIST = "1";
    const chat = service.createChat({ title: "t", harness: "opencode", profile: "opencode" });
    const first = await say(service, chat.id, "remember 42");
    expect(first.warning).toContain("did not report its session id");
    expect(chatRow(service, chat.id).session_id).toBeNull();
    await say(service, chat.id, "what number?");
    const prompts = readFileSync(log, "utf8");
    expect(prompts).toContain("User: remember 42");
  }, REAL_TURN_TIMEOUT_MS);
});
