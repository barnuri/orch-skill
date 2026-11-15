import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { ChatService } from "./service";
import { buildOptions } from "./options";
import { buildReplayPrompt } from "./sessions/history-replay";
import type { ChatStore } from "./store";
import type { MessageRow } from "./types";

const TESTING = resolve(import.meta.dir, "testing");
const REAL_DISPATCH = resolve(import.meta.dir, "../../../skills/orch/scripts/dispatch.sh");
const PROMPT_DISPATCH = join(TESTING, "fake-dispatch-prompt.sh");
const HARNESSES = ["opencode", "cursor-agent", "pi", "copilot", "local-llm"];

const PROFILES = {
  models: { m: { slug: "m", harnesses: HARNESSES } },
  profiles: Object.fromEntries(HARNESSES.map((h) => [h, { harness: h, model: "m" }])),
};

const cleanup: Array<() => Promise<void>> = [];
const saved = { path: process.env.PATH, hub: process.env.LLM_HUB_URL };
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
  process.env.PATH = saved.path;
  for (const k of ["ORCH_CHAT_DISPATCH", "ORCH_CHAT_OPENCODE_DISPATCH", "FAKE_STATE", "FAKE_AGENT_LOG", "FAKE_PROMPT_LOG", "FAKE_NO_CREATE_CHAT", "FAKE_NO_SESSION_LIST"]) {
    delete process.env[k];
  }
  if (saved.hub === undefined) {
    delete process.env.LLM_HUB_URL;
  } else {
    process.env.LLM_HUB_URL = saved.hub;
  }
});

function setup(dispatch: string): { service: ChatService; home: TempHome; state: string; log: string } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  const bin = home.resolve("bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["opencode", "cursor-agent", "pi"]) {
    copyFileSync(join(TESTING, "fake-harness.sh"), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  const state = home.resolve("fake-state");
  const log = home.resolve("agent.log");
  writeFileSync(log, "");
  process.env.PATH = `${bin}:${saved.path}`;
  process.env.FAKE_STATE = state;
  process.env.FAKE_AGENT_LOG = log;
  process.env.LLM_HUB_URL = "http://127.0.0.1:1";
  process.env.ORCH_CHAT_DISPATCH = dispatch;
  process.env.ORCH_CHAT_OPENCODE_DISPATCH = "1";
  const ctx: ServerContext = {
    paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: HARNESSES, outcomes: [],
  };
  const service = new ChatService(ctx);
  cleanup.push(() => service.dispose());
  return { service, home, state, log };
}

function store(service: ChatService): ChatStore {
  return (service as unknown as { store: ChatStore }).store;
}

/** The chat row, failing the test with a clear message when it is missing. */
function chatRow(service: Parameters<typeof store>[0], id: string) {
  const row = store(service).getChat(id);
  if (row === null) {
    throw new Error(`chat ${id} is missing`);
  }
  return row;
}

function trash(path: string): void {
  spawnSync("trash", [path]);
}

async function say(service: ChatService, chatId: string, content: string): Promise<MessageRow> {
  const r = service.sendMessage(chatId, { content });
  await service.settled(chatId);
  return store(service).getMessage(r.assistant_message_id) as MessageRow;
}

describe("memory across 3 turns, one session per chat", () => {
  for (const harness of ["opencode", "cursor-agent", "pi"]) {
    test(`${harness}: the harness session grows each turn and its id is stored`, async () => {
      const { service } = setup(REAL_DISPATCH);
      const chat = service.createChat({ title: "t", harness, profile: harness });
      const replies: string[] = [];
      for (const text of ["one", "two", "three"]) {
        const m = await say(service, chat.id, text);
        expect(m.error).toBeNull();
        expect(m.warning).toBeNull();
        replies.push(m.content);
      }
      expect(replies).toEqual(["turns=1", "turns=2", "turns=3"]);
      const stored = chatRow(service, chat.id).session_id;
      expect(stored).not.toBeNull();
      if (harness === "opencode") {
        expect(stored).toMatch(/^ses_/);
      }
    });
  }

  test("copilot keeps resuming the minted id through ORCH_RESUME_SESSION", async () => {
    const { service, log } = setup(join(TESTING, "fake-dispatch.sh"));
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

describe("a lost session falls back to a fresh one with a visible warning", () => {
  // pi is absent on purpose: `--session-id` creates a missing session, so an id can never be lost there.
  for (const harness of ["opencode", "cursor-agent"]) {
    test(harness, async () => {
      const { service, state } = setup(REAL_DISPATCH);
      const chat = service.createChat({ title: "t", harness, profile: harness });
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
    });
  }
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
  });

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
