// test-tier: slow (real dispatch.ts schedule commands and runs)
import { afterAll, describe, expect, test } from "bun:test";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const servers: TestServerHandle[] = [];

function server(): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  return srv;
}

afterAll(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
});

function post(srv: TestServerHandle, path: string, body?: unknown): Promise<Response> {
  return srv.api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function put(srv: TestServerHandle, path: string, body: unknown): Promise<Response> {
  return srv.api(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

const COMMAND = { name: "echoer", cron: "*/5 * * * *", kind: "command", command: "echo hi" };

describe.concurrent("/api/schedules", () => {
  test("an empty state dir lists nothing", async () => {
    const srv = server();
    const res = await srv.api("/api/schedules");
    expect(res.status).toBe(200);
    expect((await res.json()).schedules).toEqual([]);
  });

  test("a created command schedule is listed with its next run", async () => {
    const srv = server();
    const requestedAt = Date.now() / 1000;
    const created = await post(srv, "/api/schedules", COMMAND);
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const body = await (await srv.api("/api/schedules")).json();
    expect(body.schedules).toHaveLength(1);
    expect(body.schedules[0]).toMatchObject({ id, name: "echoer", cron: "*/5 * * * *", kind: "command", enabled: true });
    expect(body.schedules[0].next_at).toBeGreaterThan(requestedAt);
  });

  test("an unchanged list answers 304", async () => {
    const srv = server();
    await post(srv, "/api/schedules", COMMAND);
    const etag = (await srv.api("/api/schedules")).headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    expect((await srv.api("/api/schedules", { headers: { "If-None-Match": etag } })).status).toBe(304);
  });

  test("bad input is refused with 400", async () => {
    const srv = server();
    const bad: unknown[] = [
      {},
      { ...COMMAND, cron: "nope" },
      { ...COMMAND, kind: "other" },
      { name: "p", cron: "* * * * *", kind: "prompt", prompt: "hi" },
      { ...COMMAND, timeout: "soon" },
    ];
    for (const body of bad) {
      expect((await post(srv, "/api/schedules", body)).status).toBe(400);
    }
  });

  test("a schedule can be disabled, enabled and removed", async () => {
    const srv = server();
    const { id } = await (await post(srv, "/api/schedules", COMMAND)).json();
    expect((await post(srv, `/api/schedules/${id}/disable`)).status).toBe(200);
    let item = (await (await srv.api("/api/schedules")).json()).schedules[0];
    expect(item).toMatchObject({ enabled: false, next_at: null });
    expect((await post(srv, `/api/schedules/${id}/enable`)).status).toBe(200);
    item = (await (await srv.api("/api/schedules")).json()).schedules[0];
    expect(item.enabled).toBe(true);
    expect((await post(srv, `/api/schedules/${id}/remove`)).status).toBe(200);
    expect((await (await srv.api("/api/schedules")).json()).schedules).toEqual([]);
  });

  test("a schedule can be muted and unmuted", async () => {
    const srv = server();
    const { id } = await (await post(srv, "/api/schedules", COMMAND)).json();
    expect((await post(srv, `/api/schedules/${id}/mute`)).status).toBe(200);
    expect((await (await srv.api("/api/schedules")).json()).schedules[0].muted).toBe(true);
    expect((await post(srv, `/api/schedules/${id}/unmute`)).status).toBe(200);
    expect((await (await srv.api("/api/schedules")).json()).schedules[0].muted).toBe(false);
  });

  test("run-now starts a run whose output is readable", async () => {
    const srv = server();
    const { id } = await (await post(srv, "/api/schedules", COMMAND)).json();
    expect((await post(srv, `/api/schedules/${id}/run`)).status).toBe(200);
    let text = "";
    const deadline = Date.now() + 100_000;
    while (!text.includes("hi") && Date.now() < deadline) {
      await Bun.sleep(50);
      text = (await (await srv.api(`/api/schedules/${id}/runs/0/log`)).json()).text;
    }
    expect(text).toContain("hi");
  }, 300_000);

  test("preview names the next run of a valid cron and refuses a bad one", async () => {
    const srv = server();
    const ok = await srv.api("/api/schedules/preview?cron=" + encodeURIComponent("0 9 * * 1-5"));
    expect(ok.status).toBe(200);
    expect((await ok.json()).next).toMatch(/^\d{4}-\d{2}-\d{2} 09:00$/);
    for (const bad of ["", "nope", "61 * * * *", "* * *"]) {
      expect((await srv.api("/api/schedules/preview?cron=" + encodeURIComponent(bad))).status).toBe(400);
    }
  });

  test("ids and actions that are not well-formed never reach the shell", async () => {
    const srv = server();
    for (const path of ["/api/schedules/x/run", "/api/schedules/sch-20261112-101010-zzzz/run", "/api/schedules/sch-20261112-101010-abcd/explode"]) {
      expect((await post(srv, path)).status).toBe(400);
    }
    expect((await srv.api("/api/schedules/x/runs/0/log")).status).toBe(400);
  });

  test("a description is stored on create, changed on edit and cleared with an empty string", async () => {
    const srv = server();
    const { id } = await (await post(srv, "/api/schedules", { ...COMMAND, description: "says hi" })).json();
    const first = async () => (await (await srv.api("/api/schedules")).json()).schedules[0];
    expect((await first()).description).toBe("says hi");
    expect((await put(srv, `/api/schedules/${id}`, { description: "says hi twice" })).status).toBe(200);
    expect(await first()).toMatchObject({ description: "says hi twice", command: "echo hi" });
    expect((await put(srv, `/api/schedules/${id}`, { description: "" })).status).toBe(200);
    expect((await first()).description).toBeNull();
  });

  test("an edit changes the given fields and keeps the rest", async () => {
    const srv = server();
    const { id } = await (await post(srv, "/api/schedules", COMMAND)).json();
    const res = await put(srv, `/api/schedules/${id}`, { name: "renamed", cron: "30 14 * * *", command: "echo two", timeout: "5m" });
    expect(res.status).toBe(200);
    const item = (await (await srv.api("/api/schedules")).json()).schedules[0];
    expect(item).toMatchObject({ id, name: "renamed", cron: "30 14 * * *", kind: "command", command: "echo two", timeout: 300, enabled: true });
    expect(typeof item.updated_at).toBe("string");
  });

  test("an invalid edit answers 400 with the CLI's message and changes nothing", async () => {
    const srv = server();
    const { id } = await (await post(srv, "/api/schedules", COMMAND)).json();
    const res = await put(srv, `/api/schedules/${id}`, { cron: "61 * * * *" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("bad or never-matching cron");
    expect((await (await srv.api("/api/schedules")).json()).schedules[0].cron).toBe(COMMAND.cron);
    expect((await put(srv, `/api/schedules/${id}`, { kind: "prompt", prompt: "hi", profile: "no-such-profile" })).status).toBe(400);
    expect((await put(srv, `/api/schedules/${id}`, { kind: "prompt", prompt: "hi" })).status).toBe(400);
    expect((await put(srv, `/api/schedules/${id}`, {})).status).toBe(400);
    expect((await put(srv, `/api/schedules/${id}`, { timeout: "soon" })).status).toBe(400);
  });

  test("a prompt schedule stores its model through the CLI, refuses one the profile does not allow, and clears it with null", async () => {
    const srv = server();
    const prompt = { name: "modeled", cron: "0 9 * * *", kind: "prompt", prompt: "hi", profile: "claude-default" };
    const refused = await post(srv, "/api/schedules", { ...prompt, model: "claude-opus" });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toContain("not allowed for profile claude-default");
    const created = await post(srv, "/api/schedules", { ...prompt, model: "claude-sonnet" });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect((await (await srv.api("/api/schedules")).json()).schedules[0]).toMatchObject({ id, model: "claude-sonnet", profile: "claude-default" });
    expect((await put(srv, `/api/schedules/${id}`, { model: "claude-haiku" })).status).toBe(400);
    expect((await put(srv, `/api/schedules/${id}`, { model: null })).status).toBe(200);
    expect((await (await srv.api("/api/schedules")).json()).schedules[0].model).toBeNull();
    const plain = await (await post(srv, "/api/schedules", prompt)).json();
    const listed = (await (await srv.api("/api/schedules")).json()).schedules.find((s: { id: string }) => s.id === plain.id);
    expect(listed.model).toBeNull();
  });

  test("an edit of a missing or malformed id is 404 or 400", async () => {
    const srv = server();
    expect((await put(srv, "/api/schedules/sch-20261112-101010-abcd", { name: "x" })).status).toBe(404);
    expect((await put(srv, "/api/schedules/x", { name: "x" })).status).toBe(400);
  });

  test("a well-formed id that does not exist is 404", async () => {
    const srv = server();
    expect((await post(srv, "/api/schedules/sch-20261112-101010-abcd/run")).status).toBe(404);
  });
});
