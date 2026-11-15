import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const FAKE_CLAUDE = resolve(import.meta.dir, "testing/fake-claude.sh");
const PROFILES = {
  settings: { default_profile: "main", disabled_harnesses: ["pi"] },
  models: { "m-a": { slug: "alpha", harnesses: ["claude"] }, "m-b": { slug: "beta", harnesses: ["claude"] } },
  profiles: { main: { harness: "claude", model: "m-a" }, off: { harness: "pi", model: "m-a" } },
};

const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop();
  }
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
});

function server(): TestServerHandle {
  process.env.ORCH_CHAT_CLAUDE_BIN = FAKE_CLAUDE;
  const srv = startTestServer();
  srv.home.write("profiles.json", JSON.stringify(PROFILES));
  servers.push(srv);
  return srv;
}

const json = (srv: TestServerHandle, path: string, body?: unknown, method: string = "POST"): Promise<Response> =>
  srv.api(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function makeChat(srv: TestServerHandle, extra: object = {}): Promise<{ id: string }> {
  const res = await json(srv, "/api/chats", { harness: "claude", profile: "main", ...extra });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

describe("guard and routing", () => {
  test("every chat route asks for the token", async () => {
    const srv = server();
    for (const path of ["/api/chats", "/api/projects", "/api/chat-options", "/api/chats/search?q=x", "/api/attachments/att-x", "/api/chats/chat-x/events"]) {
      expect((await srv.api(path, {}, false)).status).toBe(401);
    }
  });

  test("a wrong verb is 405 with Allow", async () => {
    const srv = server();
    const chats = await srv.api("/api/chats", { method: "DELETE" });
    expect([chats.status, chats.headers.get("allow")]).toEqual([405, "GET, POST"]);
    const archive = await srv.api("/api/chats/chat-x/archive");
    expect([archive.status, archive.headers.get("allow")]).toEqual([405, "POST"]);
    expect((await srv.api("/api/projects/prj-x", { method: "DELETE" })).headers.get("allow")).toBe("GET, PUT");
  });

  test("the OpenAPI document lists the chat routes", async () => {
    const doc = (await (await server().api("/api/openapi.json")).json()) as { paths: Record<string, unknown> };
    for (const p of [
      "/api/chat-options", "/api/projects", "/api/projects/{id}", "/api/projects/{id}/archive", "/api/chats", "/api/chats/search", "/api/chats/{id}",
      "/api/chats/{id}/messages", "/api/chats/{id}/stop", "/api/chats/{id}/attachments", "/api/chats/{id}/events", "/api/attachments/{id}",
      "/api/chats/{id}/config", "/api/chats/{id}/rename", "/api/chats/{id}/project",
    ]) {
      expect(Object.keys(doc.paths)).toContain(p);
    }
  });
});

describe("options", () => {
  test("lists harnesses with profiles and models, disabled ones flagged", async () => {
    const body = (await (await server().api("/api/chat-options")).json()) as { harnesses: Array<{ id: string; enabled: boolean; persistent: boolean; profiles: Array<{ name: string; enabled: boolean; models: Array<{ id: string; default: boolean }> }> }>; default_profile: string };
    const claude = body.harnesses.find((h) => h.id === "claude");
    expect([claude?.enabled, claude?.persistent, body.default_profile]).toEqual([true, true, "main"]);
    expect(claude?.profiles[0]?.models.map((m) => [m.id, m.default])).toEqual([["m-a", true], ["m-b", false]]);
    const pi = body.harnesses.find((h) => h.id === "pi");
    expect([pi?.enabled, pi?.profiles[0]?.enabled]).toEqual([false, false]);
  });
});

describe("projects and chats", () => {
  test("project CRUD, path check, archive hides without deleting", async () => {
    const srv = server();
    const bad = await json(srv, "/api/projects", { name: "x", path: "/definitely/not/here" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toStartWith("path:");
    expect((await json(srv, "/api/projects", { name: "" })).status).toBe(400);
    const made = (await (await json(srv, "/api/projects", { name: "Work", path: srv.home.path, description: "d" })).json()) as { id: string };
    const renamed = await json(srv, `/api/projects/${made.id}`, { name: "Work 2" }, "PUT");
    expect((await renamed.json()).name).toBe("Work 2");
    await json(srv, `/api/projects/${made.id}/archive`);
    expect(((await (await srv.api("/api/projects")).json()) as { items: unknown[] }).items).toHaveLength(0);
    expect(((await (await srv.api("/api/projects?archived=1")).json()) as { items: unknown[] }).items).toHaveLength(1);
    expect((await (await srv.api(`/api/projects/${made.id}`)).json()).archived_at).not.toBeNull();
    expect((await srv.api("/api/projects/prj-nope")).status).toBe(404);
  });

  test("creating a chat enforces the rules and answers {error}", async () => {
    const srv = server();
    for (const body of [
      { harness: "pi", profile: "off" },
      { harness: "claude", profile: "main", model_id: "zzz" },
      { harness: "claude", profile: "nope" },
      { harness: "claude", profile: "main", project_id: "prj-nope" },
    ]) {
      const res = await json(srv, "/api/chats", body);
      expect(res.status).toBeOneOf([400, 404]);
      expect(Object.keys(await res.json())).toEqual(["error"]);
    }
    const missing = await json(srv, "/api/chats", { harness: "claude" });
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toStartWith("profile:");
  });

  test("lists page by cursor, with a limit of at most 100", async () => {
    const srv = server();
    const ids = [(await makeChat(srv)).id, (await makeChat(srv)).id, (await makeChat(srv)).id];
    const first = (await (await srv.api("/api/chats?limit=2")).json()) as { items: Array<{ id: string }>; next_cursor: string };
    expect(first.items).toHaveLength(2);
    const second = (await (await srv.api(`/api/chats?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`)).json()) as { items: Array<{ id: string }>; next_cursor: null };
    expect([...first.items, ...second.items].map((c) => c.id).sort()).toEqual(ids.sort());
    expect(second.next_cursor).toBeNull();
    expect((await srv.api("/api/chats?limit=101")).status).toBe(400);
  });

  test("rename, move to a project, config before the first message, archive and restore", async () => {
    const srv = server();
    const chat = await makeChat(srv);
    const project = (await (await json(srv, "/api/projects", { name: "P" })).json()) as { id: string };
    expect(((await (await json(srv, `/api/chats/${chat.id}/rename`, { title: "Named" })).json()) as { chat: { title: string } }).chat.title).toBe("Named");
    expect(((await (await json(srv, `/api/chats/${chat.id}/project`, { project_id: project.id })).json()) as { chat: { project_id: string } }).chat.project_id).toBe(project.id);
    const cfg = await json(srv, `/api/chats/${chat.id}/config`, { harness: "claude", profile: "main", model_id: "m-b" });
    expect(((await cfg.json()) as { chat: { model_id: string } }).chat.model_id).toBe("m-b");
    expect((await json(srv, `/api/chats/${chat.id}/config`, { harness: "claude", profile: "main", model_id: "zzz" })).status).toBe(400);
    await json(srv, `/api/chats/${chat.id}/archive`);
    expect(((await (await srv.api("/api/chats")).json()) as { items: unknown[] }).items).toHaveLength(0);
    expect(((await (await srv.api("/api/chats?archived=1")).json()) as { items: unknown[] }).items).toHaveLength(1);
    await json(srv, `/api/chats/${chat.id}/unarchive`);
    expect(((await (await srv.api(`/api/chats?project_id=${project.id}`)).json()) as { items: unknown[] }).items).toHaveLength(1);
  });
});

describe("uploads over HTTP", () => {
  test("multipart and pasted blobs are stored and served back safely", async () => {
    const srv = server();
    const chat = await makeChat(srv);
    const form = new FormData();
    form.append("file", new File(["hello"], "n.txt"));
    form.append("file", new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], "p.dat"));
    const up = await srv.api(`/api/chats/${chat.id}/attachments`, { method: "POST", body: form });
    expect(up.status).toBe(201);
    const items = ((await up.json()) as { items: Array<{ id: string; mime: string; filename: string; rel_path?: string }> }).items;
    expect(items.map((i) => [i.filename, i.mime])).toEqual([["n.txt", "text/plain"], ["p.dat", "image/png"]]);
    expect(items[0]?.rel_path).toBeUndefined();
    const txt = await srv.api(`/api/attachments/${items[0]?.id}`);
    expect([await txt.text(), txt.headers.get("x-content-type-options"), txt.headers.get("content-disposition")?.split(";")[0]]).toEqual(["hello", "nosniff", "attachment"]);
    expect((await srv.api(`/api/attachments/${items[1]?.id}`)).headers.get("content-disposition")).toStartWith("inline");
    const pasted = await srv.api(`/api/chats/${chat.id}/attachments`, { method: "POST", body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]), headers: { "X-Filename": "clip.jpg" } });
    expect(((await pasted.json()) as { items: Array<{ mime: string }> }).items[0]?.mime).toBe("image/jpeg");
    const evil = await srv.api(`/api/chats/${chat.id}/attachments`, { method: "POST", body: "x", headers: { "X-Filename": "../../x" } });
    expect(evil.status).toBe(400);
    expect((await srv.api("/api/attachments/att-nope")).status).toBe(404);
    expect((await srv.api("/api/chats/chat-nope/attachments", { method: "POST", body: "x" })).status).toBe(404);
  });
});

describe("a reply over HTTP", () => {
  test("202 on send, SSE streams to the end, history and search have it, a busy chat is 409", async () => {
    const srv = server();
    const chat = await makeChat(srv);
    const sse = await srv.api(`/api/chats/${chat.id}/events`);
    expect(sse.headers.get("content-type")).toStartWith("text/event-stream");
    const sent = await json(srv, `/api/chats/${chat.id}/messages`, { content: "zebra crossing" });
    expect(sent.status).toBe(202);
    const ids = (await sent.json()) as { user_message_id: string; assistant_message_id: string };
    const reader = (sse.body as ReadableStream<Uint8Array>).getReader();
    let text = "";
    const decoder = new TextDecoder();
    while (!text.includes("event: done")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    await reader.cancel();
    expect(text).toContain("event: delta");
    expect(text).toContain(`id: ${ids.assistant_message_id}.`);

    const page = (await (await srv.api(`/api/chats/${chat.id}/messages?limit=1`)).json()) as { items: Array<{ id: string; status: string; content: string }>; next_cursor: string };
    expect(page.items[0]?.id).toBe(ids.assistant_message_id);
    expect(page.items[0]?.status).toBe("done");
    expect(page.items[0]?.content).toStartWith("echo: zebra crossing");
    const older = (await (await srv.api(`/api/chats/${chat.id}/messages?cursor=${page.next_cursor}`)).json()) as { items: Array<{ id: string }> };
    expect(older.items.map((m) => m.id)).toEqual([ids.user_message_id]);

    const hits = (await (await srv.api("/api/chats/search?q=zebra")).json()) as { items: Array<{ chat_id: string; snippet: string }> };
    expect(hits.items.map((h) => h.chat_id)).toContain(chat.id);
    expect(hits.items[0]?.snippet).toContain("[[zebra]]");
    expect((await srv.api("/api/chats/search")).status).toBe(400);

    const slow = await json(srv, `/api/chats/${chat.id}/messages`, { content: "SLOW" });
    expect(slow.status).toBe(202);
    expect((await json(srv, `/api/chats/${chat.id}/messages`, { content: "again" })).status).toBe(409);
    expect((await json(srv, `/api/chats/${chat.id}/config`, { harness: "claude", profile: "main", model_id: null })).status).toBe(409);
    const stop = await json(srv, `/api/chats/${chat.id}/stop`);
    expect(await stop.json()).toEqual({ ok: true, stopped: true });
    expect((await json(srv, `/api/chats/${chat.id}/messages`, { content: "" })).status).toBe(400);
    expect((await json(srv, `/api/chats/${chat.id}/messages`, { nope: 1 })).status).toBe(400);
  });
});
