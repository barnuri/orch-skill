import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const base = realpathSync(mkdtempSync(join(tmpdir(), "chat-folders-api-")));
mkdirSync(join(base, "root/alpha"), { recursive: true });
mkdirSync(join(base, "out"), { recursive: true });
symlinkSync(join(base, "out"), join(base, "root/escape"));

const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop();
  }
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
});

const json = (srv: TestServerHandle, path: string, method: string, body?: unknown): Promise<Response> =>
  srv.api(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("folders list, set a chat folder and a project folder over HTTP; bad folders answer 400", async () => {
  process.env.ORCH_CHAT_CLAUDE_BIN = resolve(import.meta.dir, "testing/fake-claude.ts");
  const srv = startTestServer();
  servers.push(srv);
  srv.home.write("profiles.json", JSON.stringify({
    settings: { chat_roots: [join(base, "root")] },
    models: { "m-a": { slug: "alpha", harnesses: ["claude"] } },
    profiles: { main: { harness: "claude", model: "m-a" } },
  }));
  const list = (await (await srv.api("/api/chats/folders")).json()) as { root: string; items: Array<{ name: string }> };
  expect(list.items.map((i) => i.name)).toEqual(["alpha"]);
  expect((await srv.api(`/api/chats/folders?root=${encodeURIComponent(base)}`)).status).toBe(400);

  const chat = (await (await json(srv, "/api/chats", "POST", { harness: "claude", profile: "main" })).json()) as { id: string };
  const ok = await json(srv, `/api/chats/${chat.id}/folder`, "PATCH", { path: join(base, "root/alpha") });
  expect(ok.status).toBe(200);
  expect(((await ok.json()) as { chat: { cwd: string; effective_cwd: string } }).chat.effective_cwd).toBe(join(base, "root/alpha"));
  expect(((await (await srv.api(`/api/chats/${chat.id}`)).json()) as { cwd: string }).cwd).toBe(join(base, "root/alpha"));

  for (const path of [join(base, "root/escape"), `${base}/root/alpha/../../out`, "rel", join(base, "root/none")]) {
    const bad = await json(srv, `/api/chats/${chat.id}/folder`, "PATCH", { path });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/^folder:/);
  }

  const project = (await (await json(srv, "/api/projects", "POST", { name: "p" })).json()) as { id: string };
  const set = await json(srv, `/api/projects/${project.id}/folder`, "PATCH", { path: join(base, "root/alpha") });
  expect(((await set.json()) as { project: { path: string } }).project.path).toBe(join(base, "root/alpha"));
  expect((await json(srv, `/api/projects/${project.id}/folder`, "PATCH", { path: base })).status).toBe(400);
  expect((await json(srv, "/api/chats/chat-none/folder", "PATCH", { path: null })).status).toBe(404);
});
