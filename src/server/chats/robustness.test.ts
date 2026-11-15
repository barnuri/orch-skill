import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";
import { ChatStore, ftsQuery } from "./store";

const FAKE_CLAUDE = resolve(import.meta.dir, "testing/fake-claude.sh");
const PROFILES = {
  models: { "m-a": { slug: "alpha", harnesses: ["claude"] } },
  profiles: { main: { harness: "claude", model: "m-a" } },
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
const post = (srv: TestServerHandle, path: string, body: unknown): Promise<Response> =>
  srv.api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("search never answers 500 (F3)", () => {
  test("hostile queries answer 200 with a list or 400 with an error", async () => {
    const srv = server();
    const chat = (await (await post(srv, "/api/chats", { harness: "claude", profile: "main" })).json()) as { id: string };
    await post(srv, `/api/chats/${chat.id}/messages`, { content: "alpha beta gamma" });
    const hostile = ["a\u0000b", "\u0000", "\"", "\"\"\"", "a\"b", "*", "**", "NEAR(", "NEAR(a b)", "a AND", "AND OR NOT", "NOT", "a OR b", "(((", "col:y", "-x", "a".repeat(5000), "alpha\u0001\u001fbeta", "'; DROP TABLE messages;--", "{a}", "^a", "a +b"];
    for (const q of hostile) {
      const res = await srv.api(`/api/chats/search?q=${encodeURIComponent(q)}`);
      expect([200, 400], JSON.stringify(q.slice(0, 20))).toContain(res.status);
      const body = (await res.json()) as { items?: unknown[]; error?: string };
      expect(Array.isArray(body.items) || typeof body.error === "string").toBe(true);
    }
    const raw = await srv.api("/api/chats/search?q=a%00b");
    expect(raw.status).toBe(200);
  });
  test("control characters are stripped and the query is capped", () => {
    expect(ftsQuery("a\u0000b")).toBe('"a" "b"*');
    expect(ftsQuery("\u0000\u0001")).toBeNull();
    expect((ftsQuery("x".repeat(5000)) as string).length).toBeLessThan(260);
  });
  test("a store-level FTS error is an empty list", () => {
    const store = new ChatStore(":memory:");
    expect(store.search("a\u0000b", {})).toEqual([]);
    store.close();
  });
});
