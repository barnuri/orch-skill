// test-tier: slow (real opencode CLI and server processes)
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { ChatService } from "./service";
import type { ChatStore } from "./store";
import { blobPath } from "./uploads";
import { attachesNatively } from "./sessions/types";
import { OpencodeServerPool, readServeRecord, SERVE_IDLE_MS, servePaths } from "./sessions/opencode-server";

const FAKE = resolve(import.meta.dir, "testing/fake-opencode-json.ts");
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
  for (const k of ["ORCH_CHAT_OPENCODE_BIN", "FAKE_STATE", "FAKE_AGENT_LOG", "FAKE_REJECT_UNKNOWN", "FAKE_SERVE", "FAKE_SERVER_DOWN", "FAKE_BUN", "FAKE_SLOW_SECONDS"]) {
    delete process.env[k];
  }
});

function ctxFor(home: TempHome): ServerContext {
  return {
    paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: ["claude", "opencode"], outcomes: [],
  };
}

function setup(): { service: ChatService; home: TempHome; log: string } {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  const log = home.resolve("agent.log");
  writeFileSync(log, "");
  process.env.ORCH_CHAT_OPENCODE_BIN = FAKE;
  process.env.FAKE_STATE = home.resolve("fake-state");
  process.env.FAKE_AGENT_LOG = log;
  process.env.FAKE_BUN = process.execPath;
  const service = new ChatService(ctxFor(home));
  // The servers outlive the service on purpose: stop them here.
  cleanup.push(async () => {
    await service.dispose().catch(() => undefined);
    await OpencodeServerPool.stopServers(home.path);
  });
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

  test("a missing opencode binary is an error, not a lost session: no retry, no warning, the session id is kept", async () => {
    const { service, home } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    await turn(service, chat.id, "one");
    const sid = service.chat(chat.id).session_id;
    expect(sid).toStartWith("ses_");
    process.env.ORCH_CHAT_OPENCODE_BIN = home.resolve("no-such-dir/opencode");
    // A fresh chat that resumes the stored id builds its session now, with the missing binary.
    const store = (service as unknown as { store: ChatStore }).store;
    const other = service.createChat({ harness: "opencode", profile: "oc" });
    store.updateChat(other.id, { session_id: sid });
    const r = service.sendMessage(other.id, { content: "two" });
    await service.settled(other.id);
    const row = store.getMessage(r.assistant_message_id);
    expect(row?.status).toBe("error");
    expect(row?.error).toContain("code 127");
    expect(row?.warning).toBeNull();
    expect(service.chat(other.id).session_id).toBe(sid);
    expect(service.chat(other.id).status).toBe("idle");
  });

  test("a lost session id is created by the real CLI and the turn still succeeds", async () => {
    const { service } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    await turn(service, chat.id, "one");
    unlinkSync(`${process.env.FAKE_STATE}/${service.chat(chat.id).session_id ?? ""}`);
    expect(await turn(service, chat.id, "two")).toBe("turns=1");
  });

  test("attachments go as -f file parts (an extensionless image gets its extension) and stay out of the prompt", async () => {
    const { service, home, log } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    const store = (service as unknown as { store: ChatStore }).store;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const add = (filename: string, mime: string, bytes: Uint8Array, sha: string): string => {
      mkdirSync(dirname(blobPath(home.path, sha)), { recursive: true });
      writeFileSync(blobPath(home.path, sha), bytes);
      return store.addAttachment({ chat_id: chat.id, filename, mime, size: bytes.length, sha256: sha, rel_path: "x" }).id;
    };
    const ids = [add("shot", "image/png", png, "ab".repeat(32)), add("notes.txt", "text/plain", new TextEncoder().encode("hi"), "cd".repeat(32))];
    service.sendMessage(chat.id, { content: "what is this", attachment_ids: ids });
    await service.settled(chat.id);
    const [, , prompt, , files] = (readFileSync(log, "utf8").split("\n")[0] ?? "").split("\t");
    expect(prompt).toBe("what is this");
    const paths = (files ?? "").split(",");
    expect(paths).toHaveLength(2);
    expect(paths[0]).toEndWith("/shot.png");
    expect(paths[1]).toEndWith("/notes.txt");
    expect(readFileSync(paths[0] ?? "")).toEqual(Buffer.from(png));
    // opencode refuses files without a message, so a files-only turn gets a short one.
    service.sendMessage(chat.id, { content: "", attachment_ids: [add("b.txt", "text/plain", new TextEncoder().encode("yo"), "ef".repeat(32))] });
    await service.settled(chat.id);
    const second = (readFileSync(log, "utf8").split("\n")[1] ?? "").split("\t");
    expect(second[2]).toBe("See the attached files.");
    expect(second[4]).toEndWith("/b.txt");
    // A PDF is not a -f part: it stays a path in the prompt, for the agent's tools.
    service.sendMessage(chat.id, { content: "read", attachment_ids: [add("d.pdf", "application/pdf", new TextEncoder().encode("%PDF-1.4"), "12".repeat(32))] });
    await service.settled(chat.id);
    const third = readFileSync(log, "utf8").split("opencode\t")[3] ?? "";
    expect(third).toContain("read\n\nAttached files (read them from these absolute paths):\n- ");
    expect(third).toContain("/d.pdf\t");
    expect(third).toEndWith("\tstandalone\t\n");
  });

  test("images and text files attach natively; a PDF or an archive does not", () => {
    expect(["/a/x.png", "/a/n.TXT", "/a/c.json", "/a/doc.pdf", "/a/b.zip", "/a/noext"].map(attachesNatively)).toEqual([true, true, true, false, false, false]);
  });

  test("a chat created on a disabled claude is switched to opencode and then runs", async () => {
    const { service } = setup();
    const chat = service.createChat({ harness: "claude", profile: "cl" });
    expect(() => service.sendMessage(chat.id, { content: "x" })).toThrow(/Switch to opencode \(profile oc\)/);
    service.configureChat(chat.id, { harness: "opencode", profile: "oc", model_id: null });
    expect(await turn(service, chat.id, "hi")).toBe("turns=1");
  });
});

function modes(log: string): string[] {
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")[3] ?? "");
}

function servePids(): number[] {
  try {
    return readFileSync(`${process.env.FAKE_STATE}/serve.pids`, "utf8").split("\n").filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) {
      throw new Error("timed out");
    }
    await Bun.sleep(25);
  }
}

const SERVER_MODE = /^server:http:\/\/127\.0\.0\.1:\d+:pw$/;

function storeOf(service: ChatService): ChatStore {
  return (service as unknown as { store: ChatStore }).store;
}

describe("opencode turns attach to a long-lived opencode serve", () => {
  test("every turn of the profile attaches to one server, which outlives the service and is adopted by the next one", async () => {
    process.env.FAKE_SERVE = "1";
    const { service, home, log } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    expect(await turn(service, chat.id, "one")).toBe("turns=1");
    expect(await turn(service, chat.id, "two")).toBe("turns=2");
    const m = modes(log);
    expect(m).toHaveLength(2);
    expect(m.every((x) => SERVER_MODE.test(x))).toBe(true);
    const pids = servePids();
    expect(pids.length).toBe(1);
    const rec = readServeRecord(servePaths(home.path, "oc").record);
    expect(rec?.pid).toBe(pids[0] ?? -1);
    expect(rec?.profile).toBe("oc");
    expect(rec?.turns).toEqual([]);
    await service.dispose();
    expect(alive(pids[0] ?? 0)).toBe(true);
    const next = new ChatService(ctxFor(home));
    cleanup.push(() => next.dispose());
    expect(await turn(next, chat.id, "three")).toBe("turns=3");
    expect(servePids()).toEqual(pids);
  });

  test("falls back to --standalone when the server cannot start", async () => {
    const { service, log } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    expect(await turn(service, chat.id, "one")).toBe("turns=1");
    expect(modes(log)).toEqual(["standalone"]);
  });

  test("falls back to --standalone, without an error, when the server cannot be reached", async () => {
    process.env.FAKE_SERVE = "1";
    process.env.FAKE_SERVER_DOWN = "1";
    const { service, log } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    const r = service.sendMessage(chat.id, { content: "one" });
    await service.settled(chat.id);
    const row = storeOf(service).getMessage(r.assistant_message_id);
    expect(row?.status).toBe("done");
    expect(row?.content).toBe("turns=1");
    expect(modes(log)).toEqual(["standalone"]);
  });

  test("a server that dies is restarted and the next turn attaches to the new one", async () => {
    process.env.FAKE_SERVE = "1";
    const { service, log } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    expect(await turn(service, chat.id, "one")).toBe("turns=1");
    const [first] = servePids();
    process.kill(first ?? 0, "SIGKILL");
    await until(() => servePids().length === 2);
    const second = servePids()[1] ?? 0;
    expect(second).not.toBe(first);
    await until(() => service.opencodeServers?.pids().includes(second) === true);
    expect(await turn(service, chat.id, "two")).toBe("turns=2");
    expect(modes(log).every((x) => SERVER_MODE.test(x))).toBe(true);
    expect(servePids()).toHaveLength(2);
  });

  test("a turn on the server survives a dashboard restart: it completes, is stored, and the next turn reuses the server", async () => {
    process.env.FAKE_SERVE = "1";
    process.env.FAKE_SLOW_SECONDS = "2";
    const { service, home, log } = setup();
    const chat = service.createChat({ harness: "opencode", profile: "oc" });
    const r = service.sendMessage(chat.id, { content: "long" });
    await until(() => storeOf(service).getMessage(r.assistant_message_id)?.content === "slow:");
    const [serve] = servePids();
    const lease = readServeRecord(servePaths(home.path, "oc").record)?.turns ?? [];
    expect(lease).toHaveLength(1);
    await service.dispose();
    expect(alive(serve ?? 0)).toBe(true);
    expect(alive(lease[0] ?? 0)).toBe(true);
    delete process.env.FAKE_SLOW_SECONDS;
    const next = new ChatService(ctxFor(home));
    cleanup.push(() => next.dispose());
    await next.settled(chat.id);
    const row = storeOf(next).getMessage(r.assistant_message_id);
    expect(row?.status).toBe("done");
    expect(row?.content).toBe("slow:turns=1");
    expect(await turn(next, chat.id, "again")).toBe("turns=2");
    expect(servePids()).toEqual([serve ?? -1]);
    expect(modes(log).every((x) => SERVER_MODE.test(x))).toBe(true);
  });
});

describe("the serve record and its lifetime", () => {
  function poolSetup(): { home: TempHome; env: Record<string, string> } {
    const home = TempHome.create();
    process.env.FAKE_SERVE = "1";
    process.env.FAKE_STATE = home.resolve("fake-state");
    process.env.FAKE_BUN = process.execPath;
    cleanup.push(async () => {
      await OpencodeServerPool.stopServers(home.path);
    });
    return { home, env: { ...process.env } as Record<string, string> };
  }

  test("a config change replaces the server only once no turn runs on it, and never leaves two", async () => {
    const { home, env } = poolSetup();
    const pool = new OpencodeServerPool();
    cleanup.push(() => pool.stopAll());
    const a = { home: home.path, profile: "oc", config: { OPENCODE_CONFIG_CONTENT: "a" } };
    const b = { ...a, config: { OPENCODE_CONFIG_CONTENT: "b" } };
    expect(await pool.get(FAKE, env, a)).not.toBeNull();
    const [first] = servePids();
    const turnProc = Bun.spawn(["sleep", "30"]);
    pool.lease(a, turnProc.pid);
    expect(await pool.get(FAKE, env, b)).toBeNull();
    expect(alive(first ?? 0)).toBe(true);
    turnProc.kill();
    await turnProc.exited;
    expect(await pool.get(FAKE, env, b)).not.toBeNull();
    expect(alive(first ?? 0)).toBe(false);
    const pids = servePids();
    expect(pids).toHaveLength(2);
    expect(pool.pids()).toEqual([pids[1] ?? -1]);
  });

  test("an idle server is stopped after the idle time, a leased one is not", async () => {
    expect(SERVE_IDLE_MS).toBe(2 * 60 * 60 * 1000);
    const { home, env } = poolSetup();
    const pool = new OpencodeServerPool({ idleMs: 60_000, sweepMs: 3_600_000 });
    cleanup.push(() => pool.stopAll());
    const t = { home: home.path, profile: "oc", config: {} };
    expect(await pool.get(FAKE, env, t)).not.toBeNull();
    const [pid] = servePids();
    const turnProc = Bun.spawn(["sleep", "30"]);
    pool.lease(t, turnProc.pid);
    pool.sweep(Date.now() + 120_000);
    await Bun.sleep(100);
    expect(alive(pid ?? 0)).toBe(true);
    pool.release(t, turnProc.pid);
    turnProc.kill();
    pool.sweep(Date.now() + 30_000);
    await Bun.sleep(100);
    expect(alive(pid ?? 0)).toBe(true);
    pool.sweep(Date.now() + 120_000);
    await until(() => !alive(pid ?? 0));
    expect(readServeRecord(servePaths(home.path, "oc").record)?.pid).toBe(0);
  });
});
