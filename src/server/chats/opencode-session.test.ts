import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { ChatService } from "./service";
import type { ChatStore } from "./store";

const FAKE = resolve(import.meta.dir, "testing/fake-opencode-json.sh");
const PROFILES = {
  settings: { disabled_harnesses: ["claude"], default_profile: "oc" },
  models: { m: { slug: "prov/m", harnesses: ["claude", "opencode"] } },
  profiles: { cl: { harness: "claude", model: "m" }, oc: { harness: "opencode", model: "m" } },
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
  for (const k of ["ORCH_CHAT_OPENCODE_BIN", "FAKE_STATE", "FAKE_AGENT_LOG", "FAKE_REJECT_UNKNOWN"]) {
    delete process.env[k];
  }
});

function setup(): { service: ChatService; home: TempHome; log: string } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  const log = home.resolve("agent.log");
  writeFileSync(log, "");
  process.env.ORCH_CHAT_OPENCODE_BIN = FAKE;
  process.env.FAKE_STATE = home.resolve("fake-state");
  process.env.FAKE_AGENT_LOG = log;
  const ctx: ServerContext = {
    paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: ["claude", "opencode"], outcomes: [],
  };
  const service = new ChatService(ctx);
  cleanup.push(() => service.dispose());
  return { service, home, log };
}

async function turn(service: ChatService, id: string, content: string): Promise<string> {
  const r = service.sendMessage(id, { content });
  await service.settled(id);
  const store = (service as unknown as { store: ChatStore }).store;
  return store.getMessage(r.assistant_message_id)?.content ?? "";
}

describe("opencode as a chat harness", () => {
  test("streams text and tool events, records usage and the session id, resumes with --session", async () => {
    const { service, log } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    const events: string[] = [];
    service.subscribe(chat.id, null, (e) => events.push(e.event));
    expect(await turn(service, chat.id, "hello")).toBe("turns=1");
    expect(events).toContain("delta");
    expect(events).toContain("usage");
    const sid = service.chat(chat.id).session_id;
    expect(sid).toStartWith("ses_");
    expect(await turn(service, chat.id, "again")).toBe("turns=2");
    expect(service.chat(chat.id).session_id).toBe(sid);
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[1] ?? "")).toEqual([sid ?? "", sid ?? ""]);
  });

  test("a lost session starts a fresh one with a warning when the CLI rejects the id", async () => {
    const { service } = setup();
    process.env.FAKE_REJECT_UNKNOWN = "1";
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    await turn(service, chat.id, "one");
    const sid = service.chat(chat.id).session_id ?? "";
    unlinkSync(`${process.env.FAKE_STATE}/${sid}`);
    expect(await turn(service, chat.id, "two")).toBe("turns=1");
    const store = (service as unknown as { store: ChatStore }).store;
    expect(store.listMessages(chat.id, { limit: 10, cursor: null }).items.some((m) => (m.warning ?? "").includes("could not be resumed"))).toBe(true);
  });

  test("a lost session id is created by the real CLI and the turn still succeeds", async () => {
    const { service } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    await turn(service, chat.id, "one");
    unlinkSync(`${process.env.FAKE_STATE}/${service.chat(chat.id).session_id ?? ""}`);
    expect(await turn(service, chat.id, "two")).toBe("turns=1");
  });

  test("a chat created on a disabled claude is switched to opencode and then runs", async () => {
    const { service } = setup();
    const chat = service.createChat({ harness: "claude", profile: "cl" });
    expect(() => service.sendMessage(chat.id, { content: "x" })).toThrow(/Switch to opencode \(profile oc\)/);
    service.configureChat(chat.id, { harness: "opencode", profile: "oc", model_id: null });
    expect(await turn(service, chat.id, "hi")).toBe("turns=1");
  });
});
