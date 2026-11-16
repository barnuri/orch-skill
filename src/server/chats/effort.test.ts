import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { MIGRATIONS } from "./migrations";
import { buildOptions } from "./options";
import { ChatService, HttpError } from "./service";
import { ChatStore } from "./store";

const PROFILES = {
  settings: { default_profile: "cl" },
  models: { m: { slug: "prov/m", harnesses: ["claude", "opencode", "pi"] } },
  profiles: { cl: { harness: "claude", model: "m" }, oc: { harness: "opencode", model: "m" }, pi: { harness: "pi", model: "m" } },
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  for (const k of ["ORCH_CHAT_CLAUDE_BIN", "ORCH_CHAT_OPENCODE_BIN", "FAKE_STATE", "FAKE_AGENT_LOG"]) delete process.env[k];
});

function setup(): { service: ChatService; home: TempHome; log: string } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  const log = home.resolve("agent.log");
  writeFileSync(log, "");
  process.env.ORCH_CHAT_CLAUDE_BIN = resolve(import.meta.dir, "testing/fake-claude.ts");
  process.env.ORCH_CHAT_OPENCODE_BIN = resolve(import.meta.dir, "testing/fake-opencode-json.ts");
  process.env.FAKE_STATE = home.resolve("fake-state");
  process.env.FAKE_AGENT_LOG = log;
  const ctx: ServerContext = { paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true, requireRemoteToken: true, harnesses: ["claude", "opencode", "pi"], outcomes: [] };
  const service = new ChatService(ctx);
  cleanup.push(() => service.dispose());
  return { service, home, log };
}
const lines = (log: string): string[] => readFileSync(log, "utf8").split("\n").filter(Boolean);

describe("store", () => {
  test("a database from before the effort column migrates, with Auto (null) for old chats", () => {
    const path = join(mkdtempSync(join(tmpdir(), "effort-store-")), "old.db");
    const db = new Database(path);
    db.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    MIGRATIONS.slice(0, MIGRATIONS.findIndex((m) => m.includes("ADD COLUMN effort"))).forEach((sql, i) => {
      db.exec(sql);
      db.query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, 'x')").run(i + 1);
    });
    db.close();
    const store = new ChatStore(path);
    expect(store.schemaVersion()).toBe(MIGRATIONS.length);
    const chat = store.createChat({ title: "t", harness: "claude", profile: "p" });
    expect(chat.effort).toBeNull();
    expect(store.updateChat(chat.id, { effort: "high" })?.effort).toBe("high");
    expect(store.getChat(chat.id)?.effort).toBe("high");
    store.close();
  });
});

describe("options and validation", () => {
  test("only claude and opencode list levels", () => {
    const { home } = setup();
    const levels = Object.fromEntries(buildOptions(home.path, ["claude", "opencode", "pi"]).harnesses.map((h) => [h.id, h.efforts]));
    expect(levels.claude).toEqual(["low", "medium", "high", "max"]);
    expect(levels.opencode).toEqual(["low", "medium", "high", "max"]);
    expect(levels.pi).toEqual([]);
  });

  test("a harness without effort refuses one; a switch to it clears it", () => {
    const { service } = setup();
    expect(() => service.createChat({ harness: "pi", profile: "pi", effort: "high" })).toThrow(HttpError);
    const chat = service.createChat({ harness: "claude", profile: "cl", effort: "high" });
    expect(chat.effort).toBe("high");
    expect(service.configureChat(chat.id, { harness: "claude", profile: "cl", model_id: null }).effort).toBe("high");
    expect(service.configureChat(chat.id, { harness: "claude", profile: "cl", model_id: null, effort: null }).effort).toBeNull();
    service.configureChat(chat.id, { harness: "claude", profile: "cl", model_id: null, effort: "max" });
    expect(service.configureChat(chat.id, { harness: "pi", profile: "pi", model_id: null }).effort).toBeNull();
  });
});

describe("mapping to CLI arguments", () => {
  test("claude gets --effort <level> from the next turn; Auto passes nothing", async () => {
    const { service, log } = setup();
    const chat = service.createChat({ harness: "claude", profile: "cl" });
    service.sendMessage(chat.id, { content: "one" });
    await service.settled(chat.id);
    service.configureChat(chat.id, { harness: "claude", profile: "cl", model_id: null, effort: "high" });
    service.sendMessage(chat.id, { content: "two" });
    await service.settled(chat.id);
    const spawns = lines(log).map((l) => JSON.parse(l) as { args?: string[] }).filter((l) => l.args);
    expect(spawns[0]?.args).not.toContain("--effort");
    const args = spawns[1]?.args as string[];
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
  });

  test("opencode gets -m <model>#<variant>; Auto keeps the plain model", async () => {
    const { service, log } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    service.sendMessage(chat.id, { content: "one" });
    await service.settled(chat.id);
    service.configureChat(chat.id, { harness: "opencode", profile: "oc", model_id: null, effort: "max" });
    service.sendMessage(chat.id, { content: "two" });
    await service.settled(chat.id);
    expect(readFileSync(log, "utf8").split("opencode\t").slice(1).map((c) => c.trimEnd().split("\t").at(-1))).toEqual(["prov/m", "prov/m#max"]);
  });
});
