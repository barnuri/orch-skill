import { afterEach, describe, expect, test } from "bun:test";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";
import { buildOptions, chatUsageRefusal } from "./options";

const PROFILES = {
  settings: { default_profile: "runs-only", harness_usage: { opencode: ["runs"] } },
  models: { m: { slug: "alpha", harnesses: ["claude", "opencode"] } },
  profiles: {
    both: { harness: "claude", model: "m" },
    "chat-only": { harness: "claude", model: "m", usage: ["chat"] },
    "runs-only": { harness: "claude", model: "m", usage: ["runs"] },
    oc: { harness: "opencode", model: "m" },
  },
};
const HARNESSES = ["claude", "opencode"];

const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
});
function server(): TestServerHandle {
  process.env.ORCH_CHAT_CLAUDE_BIN = "/usr/bin/true";
  const srv = startTestServer();
  srv.home.write("profiles.json", JSON.stringify(PROFILES));
  servers.push(srv);
  return srv;
}
const post = (srv: TestServerHandle, path: string, body: unknown) =>
  srv.api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("chat options", () => {
  test("lists only harnesses and profiles allowed for chat", () => {
    const srv = server();
    const names = buildOptions(srv.home.path, HARNESSES).harnesses.flatMap((h) => h.profiles.map((p) => p.name));
    expect(names).toEqual(["both", "chat-only"]);
    expect(buildOptions(srv.home.path, HARNESSES).harnesses.map((h) => h.id)).toEqual(["claude"]);
  });
  test("runs-only profiles are reported with the reason, and cannot be the default", () => {
    const srv = server();
    const o = buildOptions(srv.home.path, HARNESSES);
    expect(o.not_for_chat["runs-only"]).toContain("profile runs-only is runs-only");
    expect(o.not_for_chat["oc"]).toContain("harness opencode is runs-only");
    expect(o.default_profile).toBeNull();
  });
  test("use=runs lists the runs side", () => {
    const srv = server();
    const names = buildOptions(srv.home.path, HARNESSES, "runs").harnesses.flatMap((h) => h.profiles.map((p) => p.name));
    expect(names).toEqual(["both", "runs-only", "oc"]);
  });
  test("GET /api/chat-options honours ?use=", async () => {
    const srv = server();
    const chat = (await (await srv.api("/api/chat-options")).json()) as any;
    expect(chat.harnesses.flatMap((h: any) => h.profiles.map((p: any) => p.name))).toEqual(["both", "chat-only"]);
    expect(chat.not_for_chat["runs-only"]).toBeDefined();
    const runs = (await (await srv.api("/api/chat-options?use=runs")).json()) as any;
    expect(runs.harnesses.flatMap((h: any) => h.profiles.map((p: any) => p.name))).toContain("runs-only");
    expect((await srv.api("/api/chat-options?use=nope")).status).toBe(400);
  });
});

describe("chat create and configure", () => {
  test("creating a chat on a runs-only profile or harness answers 400 with the reason", async () => {
    const srv = server();
    const a = await post(srv, "/api/chats", { harness: "claude", profile: "runs-only" });
    expect(a.status).toBe(400);
    expect(((await a.json()) as any).error).toContain("profile runs-only is runs-only");
    const b = await post(srv, "/api/chats", { harness: "opencode", profile: "oc" });
    expect(b.status).toBe(400);
    expect(((await b.json()) as any).error).toContain("harness opencode is runs-only");
    expect((await post(srv, "/api/chats", { harness: "claude", profile: "chat-only" })).status).toBe(201);
  });
  test("a chat that already uses a profile that became runs-only keeps working; moving to one is refused", async () => {
    const srv = server();
    const chat = (await (await post(srv, "/api/chats", { harness: "claude", profile: "both" })).json()) as { id: string };
    const next = structuredClone(PROFILES) as any;
    next.profiles.both.usage = ["runs"];
    srv.home.write("profiles.json", JSON.stringify(next));
    const same = await post(srv, `/api/chats/${chat.id}/config`, { harness: "claude", profile: "both", model_id: null });
    expect(same.status).toBe(200);
    const other = await post(srv, `/api/chats/${chat.id}/config`, { harness: "claude", profile: "runs-only", model_id: null });
    expect(other.status).toBe(400);
    const o = (await (await srv.api("/api/chat-options")).json()) as any;
    expect(o.not_for_chat.both).toContain("runs-only");
  });
  test("chatUsageRefusal passes unknown profiles through", () => {
    const srv = server();
    expect(chatUsageRefusal(srv.home.path, "ghost")).toBeNull();
    expect(chatUsageRefusal(srv.home.path, "runs-only")).toContain("runs-only");
  });
});
