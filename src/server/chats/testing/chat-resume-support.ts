import { afterEach } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { orchPaths } from "../../files/paths";
import { digestToken } from "../../http/auth";
import { TempHome } from "../../test-support/temp-home";
import type { ServerContext } from "../../types/server-context";
import { ChatService } from "../service";
import type { ChatStore } from "../store";
import type { MessageRow } from "../types";

/**
 * Shared setup for the chat-resume suites. The suites that drive the real dispatch.ts are split
 * one file per harness so `bun test --parallel` runs them side by side: each turn costs about
 * 1-2 s of dispatch.ts start-up, and in one file they ran back to back for about two minutes.
 * They cannot run concurrently inside one file, because every turn reads process.env.
 */
export const TESTING: string = import.meta.dir;
export const REAL_DISPATCH: string = resolve(import.meta.dir, "../../../../skills/orch/scripts/dispatch.ts");
export const PROMPT_DISPATCH: string = join(TESTING, "fake-dispatch-prompt.ts");
export const HARNESSES: readonly string[] = ["opencode", "cursor-agent", "pi", "copilot", "local-llm"];
/** A real-dispatch test runs several turns of 1-2 s each; under machine load they take far longer. */
export const REAL_TURN_TIMEOUT_MS: number = 300_000;

export const PROFILES = {
  models: { m: { slug: "m", harnesses: HARNESSES } },
  profiles: Object.fromEntries(HARNESSES.map((h) => [h, { harness: h, model: "m" }])),
};

const cleanup: Array<() => Promise<void>> = [];
const saved = { path: process.env.PATH, hub: process.env.LLM_HUB_URL };
const FAKE_ENV: readonly string[] = [
  "ORCH_CHAT_DISPATCH", "ORCH_CHAT_OPENCODE_DISPATCH", "FAKE_STATE", "FAKE_AGENT_LOG", "FAKE_PROMPT_LOG", "FAKE_NO_CREATE_CHAT", "FAKE_NO_SESSION_LIST",
];

/** Registers the afterEach that disposes services and restores the environment. Call once per file. */
export function installChatResumeCleanup(): void {
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) {
      await fn();
    }
    process.env.PATH = saved.path;
    for (const k of FAKE_ENV) {
      delete process.env[k];
    }
    if (saved.hub === undefined) {
      delete process.env.LLM_HUB_URL;
    } else {
      process.env.LLM_HUB_URL = saved.hub;
    }
  });
}

export function setup(dispatch: string): { service: ChatService; home: TempHome; state: string; log: string } {
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
    requireRemoteToken: true, harnesses: [...HARNESSES], outcomes: [],
  };
  const service = new ChatService(ctx);
  cleanup.push(() => service.dispose());
  return { service, home, state, log };
}

export function store(service: ChatService): ChatStore {
  return (service as unknown as { store: ChatStore }).store;
}

/** The chat row, failing the test with a clear message when it is missing. */
export function chatRow(service: ChatService, id: string) {
  const row = store(service).getChat(id);
  if (row === null) {
    throw new Error(`chat ${id} is missing`);
  }
  return row;
}

export function trash(path: string): void {
  spawnSync("trash", [path]);
}

export async function say(service: ChatService, chatId: string, content: string): Promise<MessageRow> {
  const r = service.sendMessage(chatId, { content });
  await service.settled(chatId);
  return store(service).getMessage(r.assistant_message_id) as MessageRow;
}
