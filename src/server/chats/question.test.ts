// test-tier: slow (detached fake claude turns)
import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { parseParts } from "../../shared/chat-parts";
import type { QuestionPart } from "../../shared/chat-question";
import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";
import { ClaudeParser } from "./sessions/claude-session";
import { OpencodeParser } from "./sessions/opencode-session";

const FAKE = resolve(import.meta.dir, "testing/fake-claude-ask.ts");
const PROFILES = { models: { "m-a": { slug: "alpha", harnesses: ["claude"] } }, profiles: { main: { harness: "claude", model: "m-a" } } };

const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop();
  }
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
  delete process.env.FAKE_AGENT_LOG;
});

describe("tool events of each harness", () => {
  test("opencode: a recorded question tool_use line (opencode 2.3.0 run) becomes a tool event with the call id and input", () => {
    const line = JSON.stringify({
      type: "tool_use", timestamp: 1, sessionID: "ses_1",
      part: { type: "tool", id: "toolu_017", tool: "question", state: { status: "error", input: { questions: [{ question: "Which color?", header: "Pick", options: [{ label: "Red", description: "warm" }] }] }, error: "This non-interactive run cannot ask the user questions, so the question was cancelled." } },
    });
    const events = new OpencodeParser(null, null).feed(`${line}\n`);
    expect(events[0]).toMatchObject({ type: "tool", name: "question", id: "toolu_017" });
    expect(events[1]).toMatchObject({ type: "tool-result", id: "toolu_017", error: true });
  });

  test("claude: an assistant tool_use AskUserQuestion block becomes a tool event; init marks the session resumable", () => {
    const p = new ClaudeParser(null);
    const events = p.feed([
      JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_a", name: "AskUserQuestion", input: { questions: [{ question: "q?", header: "h", multiSelect: false, options: [{ label: "a", description: "" }] }] } }] } }),
    ].join("\n"));
    expect(events).toEqual([expect.objectContaining({ type: "tool", name: "AskUserQuestion", id: "toolu_a" })]);
    expect(p.initSeen).toBe(true);
  });
});

function server(): TestServerHandle {
  process.env.ORCH_CHAT_CLAUDE_BIN = FAKE;
  const srv = startTestServer();
  srv.home.write("profiles.json", JSON.stringify(PROFILES));
  process.env.FAKE_AGENT_LOG = srv.home.resolve("agent.log");
  servers.push(srv);
  return srv;
}

const json = (srv: TestServerHandle, path: string, body?: unknown, method: string = "POST"): Promise<Response> =>
  srv.api(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

interface Row { id: string; role: string; content: string; status: string; parts: Array<Record<string, unknown>> | null }
const messages = async (srv: TestServerHandle, chat: string): Promise<Row[]> => ((await (await srv.api(`/api/chats/${chat}/messages?limit=100`)).json()) as { items: Row[] }).items.reverse();

async function until<T>(work: () => Promise<T | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await work();
    if (v !== null && v !== false) {
      return v;
    }
    if (Date.now() > end) {
      throw new Error("timed out");
    }
    await Bun.sleep(50);
  }
}

async function ask(srv: TestServerHandle): Promise<{ chat: string; question: QuestionPart }> {
  const chat = ((await (await json(srv, "/api/chats", { harness: "claude", profile: "main" })).json()) as { id: string }).id;
  expect((await json(srv, `/api/chats/${chat}/messages`, { content: "please ASK me" })).status).toBe(202);
  const question = await until(async () => {
    const rows = await messages(srv, chat);
    const chatRow = (await (await srv.api(`/api/chats/${chat}`)).json()) as { status: string };
    const part = rows.flatMap((r) => (r.role === "tool" ? parseParts(r.parts) ?? [] : [])).find((p): p is QuestionPart => p.type === "question");
    return part !== undefined && chatRow.status === "idle" ? part : null;
  });
  return { chat, question };
}

describe("question end to end (fake claude asks, the answer finishes the turn)", () => {
  test("the turn ends waiting (not failed), the answer endpoint delivers once, the resumed turn sees it", async () => {
    const srv = server();
    const { chat, question } = await ask(srv);
    expect(question).toMatchObject({ id: "toolu_ask1", state: "pending" });
    expect(question.questions[0]).toMatchObject({ header: "Pick", question: "Which color?", multiple: false, allowCustom: true });
    const first = (await messages(srv, chat)).find((r) => r.role === "assistant");
    expect(first?.status).toBe("done");
    const waiting = (await (await srv.api("/api/chats/questions/waiting")).json()) as { chat_ids: string[] };
    expect(waiting.chat_ids).toEqual([chat]);

    const url = `/api/chats/${chat}/questions/toolu_ask1/answer`;
    expect((await json(srv, url, { answers: [["Purple"], ["x"]] })).status).toBe(400);
    expect((await json(srv, url, {})).status).toBe(400);
    expect((await json(srv, url, { dismiss: true, answers: [["Red"]] })).status).toBe(400);
    expect((await json(srv, `/api/chats/${chat}/questions/nope/answer`, { answers: [["Red"]] })).status).toBe(404);
    const ok = await json(srv, url, { answers: [["Red"]] });
    expect(ok.status).toBe(200);
    expect((await json(srv, url, { answers: [["Blue"]] })).status).toBe(409);
    expect((await json(srv, url, { dismiss: true })).status).toBe(409);

    const done = await until(async () => {
      const rows = await messages(srv, chat);
      const last = rows.filter((r) => r.role === "assistant").at(-1);
      return rows.length > 3 && last?.status === "done" && last.content.startsWith("got:") ? rows : null;
    });
    const user = done.filter((r) => r.role === "user").at(-1) as Row;
    expect(user.content).toBe("[Answer to your question]\n- Pick: Which color? → Red");
    expect(done.filter((r) => r.role === "assistant").at(-1)?.content).toContain("[Answer to your question] ");
    const part = done.flatMap((r) => (r.role === "tool" ? parseParts(r.parts) ?? [] : [])).find((p): p is QuestionPart => p.type === "question") as QuestionPart;
    expect(part).toMatchObject({ state: "answered", answers: [["Red"]] });
    expect(((await (await srv.api("/api/chats/questions/waiting")).json()) as { chat_ids: string[] }).chat_ids).toEqual([]);
    const spawns = (await Bun.file(process.env.FAKE_AGENT_LOG as string).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l) as { args?: string[] }).filter((l) => l.args);
    expect(spawns).toHaveLength(2);
    expect(spawns[1]?.args).toContain("--resume");
  }, 60_000);

  test("skip sends a rejection and a custom answer is accepted", async () => {
    const srv = server();
    const { chat } = await ask(srv);
    const res = await json(srv, `/api/chats/${chat}/questions/toolu_ask1/answer`, { dismiss: true });
    expect(res.status).toBe(200);
    const rows = await until(async () => {
      const r = await messages(srv, chat);
      return r.filter((x) => x.role === "assistant").at(-1)?.status === "done" && r.length > 3 ? r : null;
    });
    expect(rows.filter((r) => r.role === "user").at(-1)?.content).toContain("skipped your question");
    expect(rows.flatMap((r) => (r.role === "tool" ? parseParts(r.parts) ?? [] : [])).find((p) => p.type === "question")).toMatchObject({ state: "dismissed" });
    const second = await ask(srv);
    const custom = await json(srv, `/api/chats/${second.chat}/questions/toolu_ask1/answer`, { custom: "Green" });
    expect(custom.status).toBe(200);
    expect((await until(async () => (await messages(srv, second.chat)).filter((r) => r.role === "user").at(-1) ?? null)).content).toContain("→ Green");
  }, 60_000);

  test("a normal message while a question waits dismisses it, so it no longer counts as waiting", async () => {
    const srv = server();
    const { chat } = await ask(srv);
    expect((await json(srv, `/api/chats/${chat}/messages`, { content: "never mind" })).status).toBe(202);
    await until(async () => {
      const r = await messages(srv, chat);
      return r.filter((x) => x.role === "assistant").at(-1)?.status === "done" && r.length > 3 ? r : null;
    });
    expect(((await (await srv.api("/api/chats/questions/waiting")).json()) as { chat_ids: string[] }).chat_ids).toEqual([]);
  }, 60_000);
});
