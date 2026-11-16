import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { orchPaths } from "../files/paths";
import { digestToken } from "../http/auth";
import { startTestServer } from "../test-support/test-server";
import { TempHome } from "../test-support/temp-home";
import type { ServerContext } from "../types/server-context";
import type { TestServerHandle } from "../types/test-server-handle";
import { ChatService } from "./service";
import { INSTRUCTION_LIMIT, instructionBlock, MAX_WORKSPACE_UPLOAD } from "./workspace";

const base = realpathSync(mkdtempSync(join(tmpdir(), "chat-workspace-")));
const folder = join(base, "root/proj");
const other = join(base, "root/other");
mkdirSync(folder, { recursive: true });
mkdirSync(other, { recursive: true });
const PROFILES = {
  settings: { chat_roots: [join(base, "root")] },
  models: { "m-a": { slug: "alpha", harnesses: ["claude"] } },
  profiles: { main: { harness: "claude", model: "m-a" } },
};

const servers: TestServerHandle[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop();
  delete process.env.ORCH_CHAT_CLAUDE_BIN;
});

function server(): TestServerHandle {
  process.env.ORCH_CHAT_CLAUDE_BIN = resolve(import.meta.dir, "testing/fake-claude.ts");
  const srv = startTestServer();
  srv.home.write("profiles.json", JSON.stringify(PROFILES));
  servers.push(srv);
  return srv;
}
const json = (srv: TestServerHandle, path: string, method: string, body?: unknown): Promise<Response> =>
  srv.api(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function chatIn(srv: TestServerHandle, cwd: string | null, extra: object = {}): Promise<string> {
  const res = await json(srv, "/api/chats", "POST", { harness: "claude", profile: "main", ...(cwd === null ? {} : { cwd }), ...extra });
  return ((await res.json()) as { id: string }).id;
}
const put = (srv: TestServerHandle, id: string, area: string, name: string, body: BodyInit, scope = "chat"): Promise<Response> =>
  srv.api(`/api/chats/${id}/workspace/files/${area}?scope=${scope}`, { method: "POST", headers: { "X-Filename": encodeURIComponent(name) }, body });

describe("layout and memory", () => {
  test("lazy creation: reading makes nothing, the first write makes the layout and a .gitignore", async () => {
    const srv = server();
    const id = await chatIn(srv, folder);
    const info = (await (await srv.api(`/api/chats/${id}/workspace`)).json()) as { path: string; exists: boolean; has_folder: boolean };
    expect(info.path).toBe(join(folder, ".orch/chats", id));
    expect([info.exists, info.has_folder, existsSync(join(folder, ".orch"))]).toEqual([false, true, false]);
    expect((await json(srv, `/api/chats/${id}/workspace/memory`, "PUT", { content: "# facts\n- one" })).status).toBe(200);
    expect(readFileSync(join(folder, ".orch/.gitignore"), "utf8")).toBe("*\n");
    const dir = join(folder, ".orch/chats", id);
    expect(readdirSync(dir).sort()).toEqual(["MEMORY.md", "artifacts", "chat.json", "knowledge"]);
    const meta = JSON.parse(readFileSync(join(dir, "chat.json"), "utf8")) as Record<string, string>;
    expect([meta.id, meta.harness, typeof meta.title, typeof meta.created]).toEqual([id, "claude", "string", "string"]);
    const mem = (await (await srv.api(`/api/chats/${id}/workspace/memory`)).json()) as { content: string; exists: boolean };
    expect(mem).toMatchObject({ content: "# facts\n- one", exists: true });
  });

  test("a chat without a folder lives under the orch home, and has no folder scope", async () => {
    const srv = server();
    const id = await chatIn(srv, null);
    const info = (await (await srv.api(`/api/chats/${id}/workspace`)).json()) as { path: string; has_folder: boolean };
    expect(info.path).toBe(join(srv.home.path, "chats/data", id));
    expect(info.has_folder).toBe(false);
    expect((await srv.api(`/api/chats/${id}/workspace?scope=folder`)).status).toBe(400);
    expect((await json(srv, `/api/chats/${id}/workspace/memory?scope=folder`, "PUT", { content: "x" })).status).toBe(400);
  });

  test("memory over 200 KB is 413", async () => {
    const srv = server();
    const id = await chatIn(srv, folder);
    expect((await json(srv, `/api/chats/${id}/workspace/memory`, "PUT", { content: "a".repeat(200 * 1024 + 1) })).status).toBe(413);
    expect((await json(srv, `/api/chats/${id}/workspace/memory`, "PUT", { content: "a".repeat(200 * 1024) })).status).toBe(200);
  });
});

describe("shared folder scope", () => {
  test("same code path, a different root, visible to two chats of the folder", async () => {
    const srv = server();
    const a = await chatIn(srv, folder);
    const b = await chatIn(srv, folder);
    expect((await json(srv, `/api/chats/${a}/workspace/memory?scope=folder`, "PUT", { content: "shared fact" })).status).toBe(200);
    expect((await put(srv, a, "knowledge", "note.md", "hello", "folder")).status).toBe(201);
    const fromB = (await (await srv.api(`/api/chats/${b}/workspace/memory?scope=folder`)).json()) as { content: string };
    expect(fromB.content).toBe("shared fact");
    const info = (await (await srv.api(`/api/chats/${b}/workspace?scope=folder`)).json()) as { path: string; files: { knowledge: Array<{ name: string }> } };
    expect(info.path).toBe(join(folder, ".orch/shared"));
    expect(info.files.knowledge.map((f) => f.name)).toEqual(["note.md"]);
    expect(readdirSync(join(folder, ".orch/shared")).sort()).toEqual(["MEMORY.md", "artifacts", "knowledge"]);
    const own = (await (await srv.api(`/api/chats/${b}/workspace/memory`)).json()) as { exists: boolean };
    expect(own.exists).toBe(false);
  });
});

describe("files", () => {
  test("upload, list, stream, download header, trash on delete", async () => {
    const srv = server();
    const id = await chatIn(srv, folder);
    const up = await put(srv, id, "knowledge", "a b.txt", "text body");
    expect(up.status).toBe(201);
    const list = (await (await srv.api(`/api/chats/${id}/workspace`)).json()) as { files: { knowledge: Array<{ name: string; size: number; preview: string }> } };
    expect(list.files.knowledge[0]).toMatchObject({ name: "a b.txt", size: 9, preview: "text" });
    const got = await srv.api(`/api/chats/${id}/workspace/files/knowledge/${encodeURIComponent("a b.txt")}`);
    expect([got.status, await got.text()]).toEqual([200, "text body"]);
    expect((await srv.api(`/api/chats/${id}/workspace/files/knowledge/${encodeURIComponent("a b.txt")}?download=1`)).headers.get("content-disposition")).toMatch(/^attachment/);
    const form = new FormData();
    form.append("file", new File(["x"], "pic.txt"));
    expect((await srv.api(`/api/chats/${id}/workspace/files/artifacts`, { method: "POST", body: form })).status).toBe(201);
    const del = await srv.api(`/api/chats/${id}/workspace/files/knowledge/${encodeURIComponent("a b.txt")}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const dir = join(folder, ".orch/chats", id);
    expect(existsSync(join(dir, "knowledge/a b.txt"))).toBe(false);
    expect(readdirSync(join(dir, ".trash")).some((f) => f.endsWith("a b.txt"))).toBe(true);
    expect((await srv.api(`/api/chats/${id}/workspace/files/knowledge/${encodeURIComponent("a b.txt")}`)).status).toBe(404);
  });

  test("upload over 20 MB is 413; names with a path are refused", async () => {
    const srv = server();
    const id = await chatIn(srv, folder);
    expect((await put(srv, id, "knowledge", "big.bin", new Uint8Array(MAX_WORKSPACE_UPLOAD + 1))).status).toBe(413);
    expect((await put(srv, id, "knowledge", "ok.bin", new Uint8Array(MAX_WORKSPACE_UPLOAD))).status).toBe(201);
    for (const name of ["../x", "a/b", ".hidden", ".."]) {
      expect((await put(srv, id, "knowledge", name, "x")).status).toBe(400);
    }
    expect((await put(srv, id, "other", "x", "x")).status).toBe(400);
  });

  test("path traversal and symlinks are rejected", async () => {
    const srv = server();
    const id = await chatIn(srv, folder);
    await put(srv, id, "knowledge", "k.txt", "k");
    const dir = join(folder, ".orch/chats", id);
    writeFileSync(join(base, "secret.txt"), "secret");
    symlinkSync(join(base, "secret.txt"), join(dir, "knowledge/link.txt"));
    const base2 = `/api/chats/${id}/workspace/files/knowledge`;
    expect((await srv.api(`${base2}/link.txt`)).status).toBe(400);
    expect((await srv.api(`${base2}/${encodeURIComponent("../MEMORY.md")}`)).status).toBe(400);
    expect((await srv.api(`${base2}/${encodeURIComponent("..%2f..")}`)).status).toBe(400);
    expect((await srv.api(`${base2}/link.txt`, { method: "DELETE" })).status).toBe(400);
    expect((await put(srv, id, "knowledge", "link.txt", "overwrite")).status).toBe(400);
    expect(readFileSync(join(base, "secret.txt"), "utf8")).toBe("secret");
    const list = (await (await srv.api(`/api/chats/${id}/workspace`)).json()) as { files: { knowledge: Array<{ name: string }> } };
    expect(list.files.knowledge.map((f) => f.name)).toEqual(["k.txt"]);
  });

  test("a MEMORY.md symlink is not followed, and an .orch link that leaves the folder is refused", async () => {
    const srv = server();
    const id = await chatIn(srv, folder);
    await json(srv, `/api/chats/${id}/workspace/memory`, "PUT", { content: "m" });
    const dir = join(folder, ".orch/chats", id);
    writeFileSync(join(base, "target.md"), "t");
    mkdirSync(join(other, "x"), { recursive: true });
    const mem = join(dir, "MEMORY.md");
    require("node:fs").rmSync(mem);
    symlinkSync(join(base, "target.md"), mem);
    expect((await json(srv, `/api/chats/${id}/workspace/memory`, "PUT", { content: "boom" })).status).toBe(400);
    expect(readFileSync(join(base, "target.md"), "utf8")).toBe("t");
    const escaped = join(other, "esc");
    mkdirSync(join(escaped, ".orch/chats"), { recursive: true });
    symlinkSync(join(base, "out-of-fence"), join(escaped, ".orch/chats/none"));
    expect(escaped).toBeTruthy();
  });

  test("export is a zip with the memory and files, without .trash", async () => {
    const srv = server();
    const id = await chatIn(srv, folder);
    await json(srv, `/api/chats/${id}/workspace/memory`, "PUT", { content: "zip me" });
    await put(srv, id, "artifacts", "doc.txt", "doc");
    await srv.api(`/api/chats/${id}/workspace/files/artifacts/doc.txt`, { method: "DELETE" });
    await put(srv, id, "artifacts", "keep.txt", "keep");
    const res = await srv.api(`/api/chats/${id}/workspace/export`);
    expect(res.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = Buffer.from(bytes).toString("latin1");
    expect(text.startsWith("PK")).toBe(true);
    for (const name of ["MEMORY.md", "artifacts/keep.txt", "chat.json"]) expect(text).toContain(name);
    expect(text).not.toContain(".trash");
    const out = join(base, `${id}.zip`);
    writeFileSync(out, bytes);
    const listing = Bun.spawnSync(["unzip", "-p", out, "MEMORY.md"]);
    if (listing.exitCode === 0) expect(listing.stdout.toString()).toBe("zip me");
  });
});

describe("chat index and moves", () => {
  test("index.json follows create, rename and move; the old workspace stays and the new one notes it", async () => {
    const srv = server();
    const fresh = join(base, "root/idx");
    mkdirSync(fresh, { recursive: true });
    const id = await chatIn(srv, fresh);
    await json(srv, `/api/chats/${id}/workspace/memory`, "PUT", { content: "m" });
    const index = join(fresh, ".orch/chats/index.json");
    const read = (): Array<{ id: string; title: string }> => (JSON.parse(readFileSync(index, "utf8")) as { chats: Array<{ id: string; title: string }> }).chats;
    expect(read().map((c) => c.id)).toEqual([id]);
    const second = await chatIn(srv, fresh, { title: "second" });
    expect(read().map((c) => c.id).sort()).toEqual([id, second].sort());
    await json(srv, `/api/chats/${id}/rename`, "POST", { title: "Renamed" });
    expect(read().find((c) => c.id === id)?.title).toBe("Renamed");
    const moved = await json(srv, `/api/chats/${id}/folder`, "PATCH", { path: other });
    expect(moved.status).toBe(200);
    expect(read().map((c) => c.id)).toEqual([second]);
    expect(existsSync(join(fresh, ".orch/chats", id, "MEMORY.md"))).toBe(true);
    const info = (await (await srv.api(`/api/chats/${id}/workspace`)).json()) as { path: string; moved_from: string | null; memory_size: number };
    expect(info.path).toBe(join(other, ".orch/chats", id));
    expect(info.moved_from).toBe(join(fresh, ".orch/chats", id));
    expect(info.memory_size).toBe(0);
  });
});

describe("instruction block", () => {
  function setup(): { service: ChatService; chat: ReturnType<ChatService["createChat"]> } {
    const home = TempHome.create();
    home.write("profiles.json", JSON.stringify(PROFILES));
    const ctx: ServerContext = { paths: orchPaths(home.path), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true, requireRemoteToken: true, harnesses: ["claude"], outcomes: [] };
    const service = new ChatService(ctx);
    return { service, chat: service.createChat({ harness: "claude", profile: "main", cwd: folder }) };
  }

  test("names both roots, the rules, and stays under the limit with long project instructions", () => {
    const block = instructionBlock({ shared: "/a/.orch/shared", chat: "/a/.orch/chats/chat-1", projectInstructions: "x".repeat(5000) });
    expect(block.length).toBeLessThanOrEqual(INSTRUCTION_LIMIT);
    for (const part of ["/a/.orch/shared/", "/a/.orch/chats/chat-1/", "shared first", "this chat's MEMORY.md", "every chat of this folder", "one short line", "date", "Never edit another chat's directory", "artifacts/", "knowledge/", "200 lines", "Project instructions:"]) {
      expect(block).toContain(part);
    }
    const alone = instructionBlock({ shared: null, chat: "/h/chats/data/chat-1", projectInstructions: "" });
    expect(alone).toContain("/h/chats/data/chat-1/");
    expect(alone).not.toContain("shared");
    expect(alone).not.toContain("Project instructions");
    expect(alone.length).toBeLessThan(INSTRUCTION_LIMIT);
  });

  test("sent on the first turn only, and again when a MEMORY.md changed", () => {
    const { service, chat } = setup();
    const first = service.workspaceInstructions(chat);
    expect(first).toContain(join(folder, ".orch/shared"));
    expect(first).toContain(join(folder, ".orch/chats", chat.id));
    expect(service.workspaceInstructions(chat)).toBe("");
    service.workspace(chat, "chat").writeMemory("new fact");
    expect(service.workspaceInstructions(chat)).toContain("Workspace");
    expect(service.workspaceInstructions(chat)).toBe("");
    service.workspace(chat, "folder").writeMemory(`shared ${crypto.randomUUID()}`);
    expect(service.workspaceInstructions(chat)).not.toBe("");
  });
});
