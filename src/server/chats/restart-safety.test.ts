// test-tier: slow (real server processes killed mid-turn)
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import { type ChatEvent, ChatService } from "./service";
import { INTERRUPTED_TEXT, isAlive, listTurns, sweepTurnFiles, turnPaths, writeMeta } from "./sessions/turn-files";
import { ChatStore } from "./store";

const FAKE = resolve(import.meta.dir, "testing/fake-claude-slow.sh");
const PROBE = resolve(import.meta.dir, "testing/restart-probe.ts");
const PROFILES = { models: { "m-a": { slug: "alpha", harnesses: ["claude"] } }, profiles: { main: { harness: "claude", model: "m-a" } } };

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) {
    await fn();
  }
  for (const k of ["ORCH_CHAT_CLAUDE_BIN", "FAKE_SLOW_TICKS", "FAKE_SLOW_SLEEP", "FAKE_SLOW_GATE", "FAKE_AGENT_LOG"]) {
    delete process.env[k];
  }
});

function ctxFor(home: string): ServerContext {
  return {
    paths: orchPaths(home), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: ["claude"], outcomes: [],
  };
}

function homeWith(ticks: number, sleep = "0.1"): TempHome {
  const home = TempHome.create();
  home.write("profiles.json", JSON.stringify(PROFILES));
  process.env.ORCH_CHAT_CLAUDE_BIN = FAKE;
  process.env.FAKE_SLOW_TICKS = String(ticks);
  process.env.FAKE_SLOW_SLEEP = sleep;
  return home;
}

function boot(home: TempHome): ChatService {
  const service = new ChatService(ctxFor(home.path));
  cleanup.push(() => service.dispose());
  return service;
}

async function waitFor(check: () => boolean, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting");
    }
    await Bun.sleep(25);
  }
}

const full = (n: number): string => `${Array.from({ length: n }, (_, i) => `t${i} `).join("")}done`;
const assistants = (service: ChatService, chatId: string) => service.store.messagesAfter(chatId, null).filter((m) => m.role === "assistant");

describe("restart safety of chat turns", () => {
  test("a running harness is re-attached: the answer keeps streaming and is saved once", async () => {
    const home = homeWith(12);
    const one = boot(home);
    const chat = one.createChat({ harness: "claude", profile: "main" });
    const sent = one.sendMessage(chat.id, { content: "go" });
    await waitFor(() => (one.store.getMessage(sent.assistant_message_id)?.content ?? "").includes("t1"));
    await one.dispose();
    const turn = listTurns(home.path).find((t) => t.meta.message_id === sent.assistant_message_id);
    expect(turn).toBeDefined();
    expect(isAlive((turn as { meta: { pid: number } }).meta.pid)).toBe(true);

    const two = boot(home);
    expect(two.recovered).toBe(0);
    expect(two.chat(chat.id).status).toBe("running");
    expect(two.store.getMessage(sent.assistant_message_id)?.status).toBe("streaming");
    const events: ChatEvent[] = [];
    const { replay } = two.subscribe(chat.id, `${sent.assistant_message_id}.3`, (e) => events.push(e));
    expect(replay.find((e) => e.event === "delta")?.data.text).toBe((two.store.getMessage(sent.assistant_message_id)?.content as string).slice(3));
    await two.settled(chat.id);

    const row = two.store.getMessage(sent.assistant_message_id);
    expect([row?.status, row?.content, row?.error]).toEqual(["done", full(12), null]);
    expect(row?.cost_usd).toBe(0.01);
    expect(assistants(two, chat.id)).toHaveLength(1);
    expect(events.filter((e) => e.event === "done")).toHaveLength(1);
    const streamed = events.filter((e) => e.event === "delta").map((e) => e.data.text).join("");
    expect(`${(replay.find((e) => e.event === "delta")?.data.text as string) ?? ""}${streamed}`).toBe(full(12).slice(3));
    expect([two.chat(chat.id).status, two.chat(chat.id).session_id !== null]).toEqual(["idle", true]);
  }, 120_000);

  test("a harness that ended while no server ran is finalized from its file: the answer is not lost", async () => {
    const home = homeWith(3, "0.05");
    process.env.FAKE_SLOW_GATE = join(home.path, "gate");
    const one = boot(home);
    const chat = one.createChat({ harness: "claude", profile: "main" });
    const sent = one.sendMessage(chat.id, { content: "go" });
    await waitFor(() => (one.store.getMessage(sent.assistant_message_id)?.content ?? "").includes("t2"));
    await one.dispose();
    writeFileSync(join(home.path, "gate"), "");
    await waitFor(() => existsSync(turnPaths(home.path, sent.assistant_message_id).exit));

    const two = boot(home);
    await two.settled(chat.id);
    const row = two.store.getMessage(sent.assistant_message_id);
    expect([row?.status, row?.content, row?.input_tokens, row?.output_tokens]).toEqual(["done", full(3), 3, 2]);
    expect(assistants(two, chat.id)).toHaveLength(1);
    expect(two.chat(chat.id).status).toBe("idle");
    const three = boot(home);
    expect(three.store.getMessage(sent.assistant_message_id)?.status).toBe("done");
    expect(assistants(three, chat.id)).toHaveLength(1);
  }, 120_000);

  test("a harness that died without an exit file is `interrupted`: partial text kept, session id kept, next turn resumes", async () => {
    const home = homeWith(3, "0.05");
    process.env.FAKE_SLOW_GATE = join(home.path, "never");
    process.env.FAKE_AGENT_LOG = join(home.path, "args.log");
    const one = boot(home);
    const chat = one.createChat({ harness: "claude", profile: "main" });
    const sent = one.sendMessage(chat.id, { content: "go" });
    await waitFor(() => (one.store.getMessage(sent.assistant_message_id)?.content ?? "").includes("t2"));
    await one.dispose();
    const pid = (listTurns(home.path)[0] as { meta: { pid: number } }).meta.pid;
    process.kill(-pid, "SIGKILL");
    await waitFor(() => !isAlive(pid));

    const two = boot(home);
    await two.settled(chat.id);
    const row = two.store.getMessage(sent.assistant_message_id);
    expect(row?.status).toBe("error");
    expect(row?.error).toBe(INTERRUPTED_TEXT);
    expect(row?.error).not.toContain("server restarted");
    expect(row?.content).toBe("t0 t1 t2 ");
    const after = two.chat(chat.id);
    expect([after.status, after.session_id !== null]).toEqual(["idle", true]);
    expect(assistants(two, chat.id)).toHaveLength(1);

    delete process.env.FAKE_SLOW_GATE;
    process.env.FAKE_SLOW_TICKS = "1";
    const next = two.sendMessage(chat.id, { content: "again" });
    await two.settled(chat.id);
    expect(two.store.getMessage(next.assistant_message_id)?.status).toBe("done");
    const args = readFileSync(join(home.path, "args.log"), "utf8").split("\n").filter(Boolean);
    expect(args.at(-1)).toContain(`--resume ${after.session_id}`);
  }, 120_000);

  test("stop works on a re-attached turn and kills the process group", async () => {
    const home = homeWith(200, "0.05");
    const one = boot(home);
    const chat = one.createChat({ harness: "claude", profile: "main" });
    const sent = one.sendMessage(chat.id, { content: "go" });
    await waitFor(() => (one.store.getMessage(sent.assistant_message_id)?.content ?? "").includes("t1"));
    await one.dispose();
    const pid = (listTurns(home.path)[0] as { meta: { pid: number } }).meta.pid;
    const two = boot(home);
    expect(await two.stop(chat.id)).toBe(true);
    expect(two.store.getMessage(sent.assistant_message_id)?.status).toBe("stopped");
    await waitFor(() => !isAlive(pid));
  }, 120_000);

  test("turn files older than 7 days are trashed at boot, an unfinished one never", () => {
    const home = homeWith(1);
    mkdirSync(turnPaths(home.path, "x").dir, { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const make = (id: string, pid: number, exit: boolean): void => {
      const p = turnPaths(home.path, id);
      writeMeta(p, { pid, harness: "claude", parser: "claude", session_id: null, chat_id: "c", message_id: id, model: null, started: old.toISOString(), offset: 0 });
      writeFileSync(p.out, "x");
      if (exit) {
        writeFileSync(p.exit, "0");
      }
      for (const f of [p.out, p.meta, p.exit]) {
        if (existsSync(f)) {
          utimesSync(f, old, old);
        }
      }
    };
    make("msg-finished", 999_999, true);
    make("msg-running", process.pid, false);
    make("msg-fresh", 999_999, true);
    utimesSync(turnPaths(home.path, "msg-fresh").out, new Date(), new Date());
    expect(sweepTurnFiles(home.path)).toBe(1);
    const left = readdirSync(turnPaths(home.path, "x").dir).filter((n) => n.endsWith(".jsonl")).sort();
    expect(left).toEqual(["msg-fresh.jsonl", "msg-running.jsonl"]);
  });

  test("a real server process killed with SIGKILL mid-answer: the next server finishes it, exactly one final message", async () => {
    const home = homeWith(15, "0.1");
    const seed = new ChatStore(join(home.path, "chats.db"));
    const chat = seed.createChat({ title: "t", harness: "claude", profile: "main" });
    seed.close();
    const probe = (mode: string): Bun.Subprocess<"ignore", "pipe", "inherit"> => Bun.spawn(["bun", PROBE, home.path, mode, chat.id], { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "inherit" });
    const ready = async (p: Bun.Subprocess<"ignore", "pipe", "inherit">): Promise<{ recovered: number; sent: { assistant_message_id: string } | null }> => {
      const reader = p.stdout.getReader();
      let text = "";
      while (!text.includes("\n")) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        text += new TextDecoder().decode(value);
      }
      return JSON.parse(text.split("\n")[0] as string);
    };
    const first = probe("send");
    const info = await ready(first);
    const messageId = (info.sent as { assistant_message_id: string }).assistant_message_id;
    const reader = new ChatStore(join(home.path, "chats.db"));
    cleanup.push(() => reader.close());
    await waitFor(() => (reader.getMessage(messageId)?.content ?? "").includes("t1"));
    first.kill("SIGKILL");
    await first.exited;
    const pid = (listTurns(home.path)[0] as { meta: { pid: number } }).meta.pid;
    expect(isAlive(pid)).toBe(true);

    const second = probe("recover");
    cleanup.push(() => second.kill("SIGKILL"));
    const again = await ready(second);
    expect(again.recovered).toBe(0);
    await waitFor(() => reader.getMessage(messageId)?.status === "done");
    const row = reader.getMessage(messageId);
    expect(row?.content).toBe(full(15));
    expect(reader.messagesAfter(chat.id, null).filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(reader.getChat(chat.id)?.status).toBe("idle");
  }, 180_000);
});
