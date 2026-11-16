import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";

const base = realpathSync(mkdtempSync(join(tmpdir(), "chat-subfolder-api-")));
mkdirSync(join(base, "root/proj/app/src"), { recursive: true });
mkdirSync(join(base, "root/proj/.git/objects"), { recursive: true });

const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) {
    s.stop();
  }
});

const json = (srv: TestServerHandle, path: string, method: string, body?: unknown): Promise<Response> =>
  srv.api(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("subfolder over HTTP: create, update, clear, list, get, errors, depth-2 suggestions", async () => {
  const srv = startTestServer();
  servers.push(srv);
  srv.home.write("profiles.json", JSON.stringify({
    settings: { chat_roots: [join(base, "root")] },
    models: { "m-a": { slug: "alpha", harnesses: ["claude"] } },
    profiles: { main: { harness: "claude", model: "m-a" } },
  }));
  const project = (await (await json(srv, "/api/projects", "POST", { name: "p" })).json()) as { id: string };
  await json(srv, `/api/projects/${project.id}/folder`, "PATCH", { path: join(base, "root/proj") });
  const proj = join(base, "root/proj");

  const made = await json(srv, "/api/chats", "POST", { harness: "claude", profile: "main", project_id: project.id, subfolder: "app//src/" });
  expect(made.status).toBe(201);
  const chat = (await made.json()) as { id: string; subfolder: string };
  expect(chat.subfolder).toBe("app/src");

  const read = (await (await srv.api(`/api/chats/${chat.id}`)).json()) as { subfolder: string; cwd: string | null; effective_cwd: string };
  expect([read.subfolder, read.cwd, read.effective_cwd]).toEqual(["app/src", null, join(proj, "app/src")]);
  const list = (await (await srv.api("/api/chats")).json()) as { items: Array<{ id: string; subfolder: string | null; effective_cwd: string }> };
  expect(list.items.find((i) => i.id === chat.id)).toMatchObject({ subfolder: "app/src", effective_cwd: join(proj, "app/src") });

  const upd = await json(srv, `/api/chats/${chat.id}`, "PATCH", { subfolder: "new/one" });
  expect(upd.status).toBe(200);
  expect(((await upd.json()) as { chat: { subfolder: string; effective_cwd: string } }).chat).toMatchObject({ subfolder: "new/one", effective_cwd: join(proj, "new/one") });

  for (const bad of ["/etc", "../x", "a\\b", "1/2/3/4/5/6/7"]) {
    const res = await json(srv, `/api/chats/${chat.id}`, "PATCH", { subfolder: bad });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/^subfolder: /);
  }
  expect(((await (await json(srv, `/api/chats/${chat.id}`, "PATCH", { subfolder: "" })).json()) as { chat: { subfolder: null } }).chat.subfolder).toBeNull();
  await json(srv, `/api/chats/${chat.id}`, "PATCH", { subfolder: "x" });
  expect(((await (await json(srv, `/api/chats/${chat.id}`, "PATCH", { subfolder: null })).json()) as { chat: { subfolder: null } }).chat.subfolder).toBeNull();

  const loose = (await (await json(srv, "/api/chats", "POST", { harness: "claude", profile: "main" })).json()) as { id: string };
  const none = await json(srv, `/api/chats/${loose.id}`, "PATCH", { subfolder: "a" });
  expect(none.status).toBe(400);
  expect(((await none.json()) as { error: string }).error).toBe("subfolder needs a project with a folder");
  expect((await json(srv, "/api/chats/chat-none", "PATCH", { subfolder: null })).status).toBe(404);

  const one = (await (await srv.api(`/api/chats/folders?root=${encodeURIComponent(proj)}`)).json()) as { items: Array<{ name: string }> };
  const two = (await (await srv.api(`/api/chats/folders?root=${encodeURIComponent(proj)}&depth=2`)).json()) as { items: Array<{ name: string }> };
  expect(one.items.map((i) => i.name).sort()).toEqual(["app", "new", "x"]);
  expect(two.items.map((i) => i.name)).toContain("app/src");
  expect(two.items.some((i) => i.name.includes(".git"))).toBe(false);
});

test("a symlink swapped in after the subfolder was set: read, list and update answer with the project folder and the reason", async () => {
  const srv = startTestServer();
  servers.push(srv);
  const proj = join(base, "root/swapped");
  mkdirSync(proj, { recursive: true });
  mkdirSync(join(base, "outside"), { recursive: true });
  srv.home.write("profiles.json", JSON.stringify({
    settings: { chat_roots: [join(base, "root")] },
    models: { "m-a": { slug: "alpha", harnesses: ["claude"] } },
    profiles: { main: { harness: "claude", model: "m-a" } },
  }));
  const project = (await (await json(srv, "/api/projects", "POST", { name: "p" })).json()) as { id: string };
  await json(srv, `/api/projects/${project.id}/folder`, "PATCH", { path: proj });
  const chat = (await (await json(srv, "/api/chats", "POST", { harness: "claude", profile: "main", project_id: project.id, subfolder: "app" })).json()) as { id: string };
  expect(((await (await srv.api(`/api/chats/${chat.id}`)).json()) as { effective_cwd: string; warning: string | null })).toMatchObject({ effective_cwd: join(proj, "app"), warning: null });

  rmSync(join(proj, "app"), { recursive: true });
  symlinkSync(join(base, "outside"), join(proj, "app"));
  const reason = "Subfolder app is not used (resolves outside the project folder): the agent runs in the project folder instead.";
  expect(await (await srv.api(`/api/chats/${chat.id}`)).json()).toMatchObject({ effective_cwd: proj, warning: reason });
  const list = (await (await srv.api("/api/chats")).json()) as { items: Array<{ id: string; effective_cwd: string }> };
  expect(list.items.find((i) => i.id === chat.id)?.effective_cwd).toBe(proj);
  const upd = await json(srv, `/api/chats/${chat.id}`, "PATCH", { subfolder: null });
  expect(((await upd.json()) as { chat: { effective_cwd: string; warning: string | null } }).chat).toMatchObject({ effective_cwd: proj, warning: null });
  const again = await json(srv, `/api/chats/${chat.id}`, "PATCH", { subfolder: "app" });
  expect(again.status).toBe(400);
  expect(((await again.json()) as { error: string }).error).toBe("subfolder: resolves outside the project folder");
});
