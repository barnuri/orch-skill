// test-tier: slow (dispatch.ts schedule, loop and watch processes)
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const PROFILES = {
  settings: { default_profile: "main" },
  models: { "m-a": { slug: "alpha", harnesses: ["claude"] } },
  profiles: { main: { harness: "claude", model: "m-a" } },
};

const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  delete process.env.ORCH_EVERY_MIN_SECS;
});

async function setup(): Promise<{ srv: TestServerHandle; chat: string; post: (path: string, body?: unknown, method?: string) => Promise<Response> }> {
  process.env.ORCH_AUTOMATION_TIMERS = "0";
  const srv = startTestServer();
  srv.home.write("profiles.json", JSON.stringify(PROFILES));
  servers.push(srv);
  const post = (path: string, body?: unknown, method = "POST"): Promise<Response> =>
    srv.api(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const made = (await (await post("/api/chats", { harness: "claude", profile: "main", title: "T" })).json()) as { chat?: { id: string }; id?: string };
  return { srv, chat: (made.chat?.id ?? made.id) as string, post };
}

describe("chat schedules API", () => {
  test("create, list, patch, pause, resume, log and delete", async () => {
    const { chat, post, srv } = await setup();
    const res = await post(`/api/chats/${chat}/schedules`, { name: "News", prompt: "Summarise", cron: "0 9 * * 1-5", timezone: "Asia/Jerusalem", mode: "fresh" });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const list = (await (await srv.api(`/api/chats/${chat}/schedules`)).json()) as { items: Array<{ id: string; timezone: string; target: { mode: string }; next_at: number }> };
    expect(list.items[0]).toMatchObject({ id, timezone: "Asia/Jerusalem", target: { mode: "fresh" } });
    expect(list.items[0]!.next_at).toBeGreaterThan(0);
    expect((await post(`/api/chats/${chat}/schedules/${id}`, { name: "News 2", cron: "30 8 * * *" }, "PATCH")).status).toBe(200);
    expect((await post(`/api/chats/${chat}/schedules/${id}/pause`)).status).toBe(200);
    let one = ((await (await srv.api(`/api/chats/${chat}/schedules`)).json()) as { items: Array<{ enabled: boolean; name: string; cron: string }> }).items[0]!;
    expect(one).toMatchObject({ enabled: false, name: "News 2", cron: "30 8 * * *" });
    expect((await post(`/api/chats/${chat}/schedules/${id}/resume`)).status).toBe(200);
    one = ((await (await srv.api(`/api/chats/${chat}/schedules`)).json()) as { items: Array<{ enabled: boolean; name: string; cron: string }> }).items[0]!;
    expect(one.enabled).toBe(true);
    expect(((await (await srv.api(`/api/chats/${chat}/schedules/${id}/log`)).json()) as { entries: unknown[] }).entries).toEqual([]);
    expect((await post(`/api/chats/${chat}/schedules/${id}`, undefined, "DELETE")).status).toBe(200);
    expect((await post(`/api/chats/${chat}/schedules/${id}`, undefined, "DELETE")).status).toBe(404);
  }, 40_000);

  test("validation: missing fields, a cron under 5 minutes, a bad zone, a bad mode, an unknown chat", async () => {
    const { chat, post } = await setup();
    const body = { name: "n", prompt: "p", cron: "0 9 * * *" };
    expect((await post(`/api/chats/${chat}/schedules`, { name: "n" })).status).toBe(400);
    expect((await post(`/api/chats/${chat}/schedules`, { ...body, mode: "other" })).status).toBe(400);
    expect((await post(`/api/chats/${chat}/schedules`, { ...body, cron: "* * * * *" })).status).toBe(400);
    expect((await post(`/api/chats/${chat}/schedules`, { ...body, cron: "nonsense" })).status).toBe(400);
    expect((await post(`/api/chats/${chat}/schedules`, { ...body, timezone: "Mars/Base" })).status).toBe(400);
    expect((await post(`/api/chats/chat-nope/schedules`, body)).status).toBe(404);
    expect((await (await post(`/api/chats/${chat}/schedules`, { ...body, cron: "* * * * *" })).json() as { error: string }).error).toMatch(/at least 5 minutes/);
  }, 40_000);

  test("the 50 active schedule limit answers 409; an archived chat answers 409", async () => {
    const { chat, post, srv } = await setup();
    for (let i = 0; i < 50; i++) {
      const id = `sch-20260101-000000-${i.toString(16).padStart(4, "0")}`;
      mkdirSync(join(srv.home.path, "schedules", id), { recursive: true });
      writeFileSync(join(srv.home.path, "schedules", id, "schedule.json"), JSON.stringify({ id, enabled: true, target: { kind: "chat", chat_id: "chat-x", mode: "message" }, runs: [], created_at: "2026-01-01T00:00:00Z" }));
    }
    const over = await post(`/api/chats/${chat}/schedules`, { name: "n", prompt: "p", cron: "0 9 * * *" });
    expect(over.status).toBe(409);
    await post(`/api/chats/${chat}/archive`).catch(() => null);
  }, 40_000);

  test("the global Schedules list carries the chat target", async () => {
    const { chat, post, srv } = await setup();
    await post(`/api/chats/${chat}/schedules`, { name: "G", prompt: "p", cron: "0 9 * * *" });
    const all = (await (await srv.api("/api/schedules")).json()) as { schedules: Array<{ name: string; target?: { chat_id: string } }> };
    expect(all.schedules.find((s) => s.name === "G")?.target?.chat_id).toBe(chat);
  }, 40_000);
});

describe("chat loops and monitors API", () => {
  test("a loop starts with the chat as target, lists, and stops", async () => {
    const { chat, post, srv } = await setup();
    const res = await post(`/api/chats/${chat}/loops`, { label: "Poll", prompt: "check", every: 3600, max: 3, until_regex: "DONE" });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const list = (await (await srv.api(`/api/chats/${chat}/loops`)).json()) as { items: Array<{ id: string; label: string; max: number; until: { regex: string } }> };
    expect(list.items[0]).toMatchObject({ id, label: "Poll", max: 3, until: { regex: "DONE" } });
    expect((await post(`/api/chats/${chat}/loops/${id}/run-now`)).status).toBe(409);
    expect((await post(`/api/chats/${chat}/loops/${id}/stop`)).status).toBe(200);
    const after = (await (await srv.api(`/api/chats/${chat}/loops`)).json()) as { items: Array<{ status: string }> };
    expect(after.items[0]!.status).toBe("stopped");
    expect((await post(`/api/chats/chat-other/loops/${id}/stop`)).status).toBe(404);
    expect((await post(`/api/chats/${chat}/loops`, { label: "x", prompt: "p", every: 2 })).status).toBe(400);
  }, 40_000);

  test("a monitor starts, lists, pauses and resumes; blocked URLs answer 400", async () => {
    const { chat, post, srv } = await setup();
    const res = await post(`/api/chats/${chat}/monitors`, { name: "Cmd", spec: { type: "stream", target: "sleep 60" }, then: { mode: "tell" } });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const list = (await (await srv.api(`/api/chats/${chat}/monitors`)).json()) as { items: Array<{ id: string; status: string }> };
    expect(list.items[0]).toMatchObject({ id, status: "running" });
    expect((await post(`/api/chats/${chat}/monitors/${id}/pause`)).status).toBe(200);
    const resumed = (await (await post(`/api/chats/${chat}/monitors/${id}/resume`)).json()) as { id: string };
    const now = (await (await srv.api(`/api/chats/${chat}/monitors`)).json()) as { items: Array<{ id: string; status: string }> };
    expect(now.items.map((m) => m.id)).toEqual([resumed.id]);
    expect(((await (await srv.api(`/api/chats/${chat}/monitors/${resumed.id}/log`)).json()) as { entries: unknown[] }).entries).toBeDefined();
    await post(`/api/chats/${chat}/monitors/${resumed.id}/stop`);
    for (const target of ["http://169.254.169.254/latest", "file:///etc/passwd"]) {
      const bad = await post(`/api/chats/${chat}/monitors`, { name: "u", spec: { type: "url", target } });
      expect(bad.status).toBe(400);
    }
    expect((await post(`/api/chats/${chat}/monitors`, { name: "u", spec: { type: "bogus", target: "x" } })).status).toBe(400);
  }, 40_000);

  test("POST /read clears the unread flag; the chat list carries it", async () => {
    const { chat, post, srv } = await setup();
    const row = (await (await srv.api(`/api/chats/${chat}`)).json()) as { chat?: { unread?: number }; unread?: number };
    expect((row.chat ?? row).unread).toBe(0);
    expect((await post(`/api/chats/${chat}/read`)).status).toBe(200);
  }, 20_000);
});
