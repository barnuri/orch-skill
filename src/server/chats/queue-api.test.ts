// test-tier: slow (detached fake claude turns)
import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const FAKE_SLOW = resolve(import.meta.dir, "testing/fake-claude-slow.ts");
const PROFILES = {
  settings: { default_profile: "main" },
  models: { "m-a": { slug: "alpha", harnesses: ["claude"] } },
  profiles: { main: { harness: "claude", model: "m-a" } },
};

const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop();
  }
  for (const k of ["ORCH_CHAT_CLAUDE_BIN", "FAKE_SLOW_TICKS", "FAKE_SLOW_SLEEP", "FAKE_SLOW_GATE"]) {
    delete process.env[k];
  }
});

function server(): TestServerHandle {
  process.env.ORCH_CHAT_CLAUDE_BIN = FAKE_SLOW;
  process.env.FAKE_SLOW_TICKS = "2";
  process.env.FAKE_SLOW_SLEEP = "0.05";
  const srv = startTestServer();
  srv.home.write("profiles.json", JSON.stringify(PROFILES));
  servers.push(srv);
  return srv;
}

const json = (srv: TestServerHandle, path: string, body?: unknown, method: string = "POST"): Promise<Response> =>
  srv.api(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

interface Snap { items: Array<{ id: string; text: string; state: string; position: number }>; paused: boolean; reason: string | null }

async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error("timed out waiting");
    }
    await Bun.sleep(50);
  }
}

async function queueOf(srv: TestServerHandle, chatId: string): Promise<Snap> {
  return (await (await srv.api(`/api/chats/${chatId}/queue`)).json()) as Snap;
}

async function userTexts(srv: TestServerHandle, chatId: string): Promise<string[]> {
  const page = (await (await srv.api(`/api/chats/${chatId}/messages?limit=100`)).json()) as { items: Array<{ role: string; content: string; status: string }> };
  return page.items.filter((m) => m.role === "user").map((m) => m.content).reverse();
}

describe("chat queue API", () => {
  test("end to end: three queued messages run one after another in order, against a real (fake) harness process", async () => {
    const srv = server();
    const chat = (await (await json(srv, "/api/chats", { harness: "claude", profile: "main" })).json()) as { id: string };
    const first = await json(srv, `/api/chats/${chat.id}/messages`, { content: "first" });
    expect(first.status).toBe(202);
    expect(((await first.json()) as { queued: boolean }).queued).toBe(false);
    const ids: string[] = [];
    for (const text of ["second", "third", "fourth"]) {
      const res = await json(srv, `/api/chats/${chat.id}/messages`, { content: text });
      expect(res.status).toBe(202);
      const body = (await res.json()) as { queued: boolean; queue_id: string; user_message_id: string | null };
      expect([body.queued, body.user_message_id]).toEqual([true, null]);
      ids.push(body.queue_id);
    }
    const waiting = await queueOf(srv, chat.id);
    expect(waiting.items.map((i) => i.text)).toEqual(["second", "third", "fourth"]);
    await until(async () => {
      const q = await queueOf(srv, chat.id);
      const c = (await (await srv.api(`/api/chats/${chat.id}`)).json()) as { status: string };
      return q.items.length === 0 && c.status === "idle";
    });
    expect(await userTexts(srv, chat.id)).toEqual(["first", "second", "third", "fourth"]);
    const page = (await (await srv.api(`/api/chats/${chat.id}/messages?limit=100`)).json()) as { items: Array<{ role: string; status: string }> };
    expect(page.items.filter((m) => m.role === "assistant").map((m) => m.status)).toEqual(["done", "done", "done", "done"]);
    expect((await queueOf(srv, chat.id)).paused).toBe(false);
  }, 60_000);

  test("routes: list, enqueue, edit, reorder, delete, send-now, resume, stop; 409 and 404 answers", async () => {
    const srv = server();
    process.env.FAKE_SLOW_TICKS = "400";
    const chat = (await (await json(srv, "/api/chats", { harness: "claude", profile: "main" })).json()) as { id: string };
    const base = `/api/chats/${chat.id}`;
    expect((await json(srv, `${base}/messages`, { content: "long one" })).status).toBe(202);
    const add = async (text: string): Promise<string> => {
      const res = await json(srv, `${base}/queue`, { content: text });
      expect(res.status).toBe(201);
      return ((await res.json()) as { item: { id: string } }).item.id;
    };
    const [a, b, c] = [await add("a"), await add("b"), await add("c")] as [string, string, string];
    const edit = await json(srv, `${base}/queue/${b}`, { content: "b edited" }, "PATCH");
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { item: { text: string; edited_at: string } }).item).toMatchObject({ text: "b edited" });
    const re = await json(srv, `${base}/queue/reorder`, { ids: [c, a] });
    expect(((await re.json()) as Snap).items.map((i) => i.text)).toEqual(["c", "a", "b edited"]);
    const del = await json(srv, `${base}/queue/${a}`, undefined, "DELETE");
    expect(((await del.json()) as { item: { state: string } }).item.state).toBe("cancelled");
    expect((await json(srv, `${base}/queue/${a}`, { content: "x" }, "PATCH")).status).toBe(409);
    expect((await json(srv, `${base}/queue/que-none`, { content: "x" }, "PATCH")).status).toBe(404);
    expect((await srv.api("/api/chats/chat-none/queue")).status).toBe(404);
    expect((await json(srv, `${base}/queue`, { content: "" })).status).toBe(400);
    expect((await json(srv, `${base}/queue`, { content: "x".repeat(50 * 1024 + 1) })).status).toBe(413);
    const sendNow = await json(srv, `${base}/queue/${b}/send-now`);
    expect(sendNow.status).toBe(200);
    expect(((await sendNow.json()) as { interrupted: boolean }).interrupted).toBe(true);
    await until(async () => (await queueOf(srv, chat.id)).items[0]?.state === "running");
    expect((await queueOf(srv, chat.id)).items.map((i) => [i.text, i.state])).toEqual([["b edited", "running"], ["c", "queued"]]);
    expect((await json(srv, `${base}/queue/${b}`, { content: "late" }, "PATCH")).status).toBe(409);
    const stop = await json(srv, `${base}/stop`);
    expect(((await stop.json()) as { stopped: boolean }).stopped).toBe(true);
    const paused = await queueOf(srv, chat.id);
    expect([paused.paused, paused.items.map((i) => i.text)]).toEqual([true, ["c"]]);
    process.env.FAKE_SLOW_TICKS = "1";
    const resumed = await json(srv, `${base}/queue/resume`);
    expect(((await resumed.json()) as Snap).paused).toBe(false);
    await until(async () => (await queueOf(srv, chat.id)).items.length === 0);
    expect(await userTexts(srv, chat.id)).toEqual(["long one", "b edited", "c"]);
  }, 60_000);

  test("send now on the 3rd of 3 queued: sends only it; the other 2 stay queued, the queue pauses; resume sends the next one", async () => {
    const srv = server();
    process.env.FAKE_SLOW_TICKS = "400";
    const chat = (await (await json(srv, "/api/chats", { harness: "claude", profile: "main" })).json()) as { id: string };
    const base = `/api/chats/${chat.id}`;
    expect((await json(srv, `${base}/messages`, { content: "long one" })).status).toBe(202);
    const add = async (text: string): Promise<string> => ((await (await json(srv, `${base}/queue`, { content: text })).json()) as { item: { id: string } }).item.id;
    await add("a");
    await add("b");
    const c = await add("c");
    process.env.FAKE_SLOW_TICKS = "1";
    const sent = await json(srv, `${base}/queue/${c}/send-now`);
    expect(((await sent.json()) as { interrupted: boolean }).interrupted).toBe(true);
    await until(async () => {
      const q = await queueOf(srv, chat.id);
      return q.paused && q.items.length === 2;
    });
    const paused = await queueOf(srv, chat.id);
    expect(paused).toMatchObject({ paused: true, reason: "Sent one message now. 2 more are waiting: Resume to send them." });
    expect(paused.items.map((i) => [i.text, i.state])).toEqual([["a", "queued"], ["b", "queued"]]);
    expect(await userTexts(srv, chat.id)).toEqual(["long one", "c"]);
    const resumed = await json(srv, `${base}/queue/resume`);
    expect(((await resumed.json()) as Snap).paused).toBe(false);
    await until(async () => (await queueOf(srv, chat.id)).items.length === 0);
    expect(await userTexts(srv, chat.id)).toEqual(["long one", "c", "a", "b"]);
  }, 60_000);

  test("the OpenAPI document lists the queue routes", async () => {
    const doc = (await (await server().api("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
    for (const p of ["/api/chats/{id}/queue", "/api/chats/{id}/queue/{qid}", "/api/chats/{id}/queue/{qid}/send-now", "/api/chats/{id}/queue/reorder", "/api/chats/{id}/queue/resume"]) {
      expect(Object.keys(doc.paths)).toContain(p);
    }
  });
});
