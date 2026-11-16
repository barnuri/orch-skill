import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { TempHome } from "../test-support/temp-home";
import { buildOptions } from "./options";
import { buildReplayPrompt } from "./sessions/history-replay";
import { HARNESSES, installChatResumeCleanup, PROFILES, PROMPT_DISPATCH, say, setup, TESTING } from "./testing/chat-resume-support";

// The tests that drive the real dispatch.ts live in chat-resume-{opencode,cursor,pi}.test.ts,
// one file per harness so the parallel runner overlaps them.
installChatResumeCleanup();

describe("memory across 3 turns, one session per chat", () => {
  test("copilot keeps resuming the minted id through ORCH_RESUME_SESSION", async () => {
    const { service, log } = setup(join(TESTING, "fake-dispatch.ts"));
    const chat = service.createChat({ title: "t", harness: "copilot", profile: "copilot" });
    process.env.FAKE_AGENT_LOG = log;
    await say(service, chat.id, "a");
    await say(service, chat.id, "b");
    const rows = readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { resume: string; session: string });
    expect(rows[0]?.session).not.toBe("");
    expect(rows[1]?.resume).toBe(rows[0]?.session as string);
  });

  test("local-llm replays the earlier turns in the prompt", async () => {
    const { service, home } = setup(PROMPT_DISPATCH);
    const promptLog = home.resolve("prompts.log");
    process.env.FAKE_PROMPT_LOG = promptLog;
    const chat = service.createChat({ title: "t", harness: "local-llm", profile: "local-llm" });
    await say(service, chat.id, "my name is Dana");
    await say(service, chat.id, "second");
    const m = await say(service, chat.id, "what is my name?");
    const last = readFileSync(promptLog, "utf8").split("\n=====\n").filter(Boolean).pop() as string;
    expect(last).toContain("User: my name is Dana");
    expect(last).toContain("Assistant: chars=");
    expect(last.endsWith("New message from the user:\nwhat is my name?")).toBe(true);
    expect(m.context_truncated).toBe(0);
  });
});

describe("replay budget", () => {
  const history = [
    { role: "user" as const, content: "A".repeat(400) },
    { role: "assistant" as const, content: "B".repeat(400) },
    { role: "user" as const, content: "C".repeat(400) },
  ];

  test("everything fits: nothing is flagged", () => {
    const r = buildReplayPrompt(history, "now", 5000);
    expect(r.truncated).toBe(false);
    expect(r.included).toBe(3);
  });

  test("oldest messages are dropped first", () => {
    const r = buildReplayPrompt(history, "now", 900);
    expect(r.truncated).toBe(true);
    expect(r.prompt).toContain("C".repeat(400));
    expect(r.prompt).not.toContain("A".repeat(400));
    expect(r.prompt).toContain("Earlier messages were omitted");
    expect(r.prompt.endsWith("now")).toBe(true);
  });

  test("one oversized message is cut from its start and the rest dropped", () => {
    const r = buildReplayPrompt([{ role: "user", content: "x".repeat(100) + "TAIL" }], "now", 50);
    expect(r.truncated).toBe(true);
    expect(r.prompt).toContain("TAIL");
    expect(r.prompt).not.toContain("x".repeat(100));
  });

  test("no history leaves the prompt unchanged", () => {
    expect(buildReplayPrompt([], "hi").prompt).toBe("hi");
  });
});

describe("context_truncated on the stored message", () => {
  test("a long local-llm chat sets the flag on the reply that lost context", async () => {
    const { service, home } = setup(PROMPT_DISPATCH);
    process.env.FAKE_PROMPT_LOG = home.resolve("prompts.log");
    const chat = service.createChat({ title: "t", harness: "local-llm", profile: "local-llm" });
    const big = "z".repeat(15_000);
    await say(service, chat.id, big);
    await say(service, chat.id, big);
    const m = await say(service, chat.id, "third");
    expect(m.context_truncated).toBe(1);
  });
});

describe("/api/chat-options memory", () => {
  test("persistent stays true only for claude; memory says how the others remember", () => {
    const home = TempHome.create();
    home.write("profiles.json", JSON.stringify(PROFILES));
    const opts = buildOptions(home.path, ["claude", ...HARNESSES]);
    const by = Object.fromEntries(opts.harnesses.map((h) => [h.id, [h.persistent, h.memory]]));
    expect(by).toEqual({
      claude: [true, "process"], opencode: [false, "session"], "cursor-agent": [false, "session"], pi: [false, "session"], copilot: [false, "session"], "local-llm": [false, "replay"],
    });
  });
});
