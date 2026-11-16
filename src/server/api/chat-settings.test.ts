// test-tier: slow (real dispatch.ts serve config, real profiles save)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const JSON_HEADERS = { "Content-Type": "application/json" };
const previous = process.env["ORCH_DISPATCH"];
const servers: TestServerHandle[] = [];

beforeAll(() => {
  delete process.env["ORCH_DISPATCH"];
});
afterAll(() => {
  for (const srv of servers.splice(0)) {
    srv.stop();
  }
  if (previous !== undefined) {
    process.env["ORCH_DISPATCH"] = previous;
  }
});

function server(): TestServerHandle {
  const srv = startTestServer();
  servers.push(srv);
  return srv;
}

const putJson = (srv: TestServerHandle, path: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> =>
  srv.api(path, { method: "PUT", headers: { ...JSON_HEADERS, ...extra }, body: JSON.stringify(body) });

describe("secure-link hint setting", () => {
  test("PUT writes serve.json through dispatch and server-info reports it at once", async () => {
    const srv = server();
    expect(((await (await srv.api("/api/server-info")).json()) as { secure_link_hint: boolean }).secure_link_hint).toBe(true);
    const off = await putJson(srv, "/api/chat-settings/secure-link-hint", { secure_link_hint: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ secure_link_hint: false });
    expect(JSON.parse(srv.home.read("serve.json")).secure_link_hint).toBe(false);
    expect(((await (await srv.api("/api/server-info")).json()) as { secure_link_hint: boolean }).secure_link_hint).toBe(false);
    expect((await putJson(srv, "/api/chat-settings/secure-link-hint", { secure_link_hint: true })).status).toBe(200);
    expect(JSON.parse(srv.home.read("serve.json")).secure_link_hint).toBe(true);
    expect(((await (await srv.api("/api/server-info")).json()) as { secure_link_hint: boolean }).secure_link_hint).toBe(true);
  }, 60_000);

  test("a body that is not a boolean is refused and nothing is written", async () => {
    const srv = server();
    expect((await putJson(srv, "/api/chat-settings/secure-link-hint", { secure_link_hint: "no" })).status).toBe(400);
    expect((await putJson(srv, "/api/chat-settings/secure-link-hint", {})).status).toBe(400);
    expect(existsSync(srv.home.resolve("serve.json"))).toBe(false);
  });

  test("it needs the token", async () => {
    const srv = server();
    const res = await srv.api("/api/chat-settings/secure-link-hint", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify({ secure_link_hint: false }) }, false);
    expect(res.status).toBe(401);
  });
});

describe("chat settings in the profiles document", () => {
  test("PUT /api/profiles saves schedule_grace_hours, monitor_allow_link_local and chat_roots, and refuses bad ones with their path", async () => {
    const srv = server();
    const get = await srv.api("/api/profiles");
    const etag = get.headers.get("etag") ?? "";
    const doc = (await get.json()).document;
    doc.settings.schedule_grace_hours = 12;
    doc.settings.monitor_allow_link_local = true;
    doc.settings.chat_roots = ["~/sandbox/private", "/srv/work"];
    const saved = await putJson(srv, "/api/profiles", doc, { "If-Match": etag });
    expect(saved.status).toBe(200);
    expect(JSON.parse(srv.home.read("profiles.json")).settings).toMatchObject({ schedule_grace_hours: 12, monitor_allow_link_local: true, chat_roots: ["~/sandbox/private", "/srv/work"] });

    const again = await srv.api("/api/profiles");
    const doc2 = (await again.json()).document;
    doc2.settings.schedule_grace_hours = 73;
    doc2.settings.monitor_allow_link_local = "yes";
    doc2.settings.chat_roots = ["relative"];
    const bad = await putJson(srv, "/api/profiles", doc2, { "If-Match": again.headers.get("etag") ?? "" });
    expect(bad.status).toBe(400);
    const issues = ((await bad.json()) as { issues: Array<{ path: string }> }).issues.map((i) => i.path).sort();
    expect(issues).toEqual(["settings.chat_roots[0]", "settings.monitor_allow_link_local", "settings.schedule_grace_hours"]);
  }, 60_000);
});
