import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ArtifactEvent } from "../../shared/artifacts";
import { startTestServer } from "../test-support/test-server";
import type { TestServerHandle } from "../types/test-server-handle";
import { ArtifactHub, ArtifactStore, externalCandidate, hashOf } from "./artifacts";
import { Workspace } from "./workspace";

const base = realpathSync(mkdtempSync(join(tmpdir(), "chat-artifacts-")));
let counter = 0;
function store(): { store: ArtifactStore; root: string; dir: string } {
  const root = join(base, `ws${++counter}`);
  const ws = new Workspace("chat", root, null);
  ws.ensure();
  return { store: new ArtifactStore(ws), root, dir: join(root, "artifacts") };
}

describe("versions", () => {
  test("a changed file is snapshotted with its turn, an unchanged one is not", () => {
    const { store: s, dir } = store();
    writeFileSync(join(dir, "a.html"), "<p>1</p>");
    expect(s.snapshot("a.html", "agent", "msg-1")?.n).toBe(1);
    expect(s.snapshot("a.html", "agent", "msg-1")).toBeNull();
    writeFileSync(join(dir, "a.html"), "<p>2</p>");
    const v2 = s.snapshot("a.html", "agent", "msg-2");
    expect(v2).toMatchObject({ n: 2, turn: "msg-2", author: "agent", hash: hashOf(new TextEncoder().encode("<p>2</p>")) });
    expect(readFileSync(join(dir, ".versions/a.html/1"), "utf8")).toBe("<p>1</p>");
    expect(s.versions("a.html").map((v) => v.n)).toEqual([1, 2]);
    expect(s.info("a.html").version).toBe(2);
  });

  test("a user write keeps the unseen agent content as a version first, then records the user's", () => {
    const { store: s, dir } = store();
    writeFileSync(join(dir, "a.md"), "agent");
    s.write("a.md", new TextEncoder().encode("user"), "user");
    expect(s.versions("a.md").map((v) => [v.n, v.author])).toEqual([[1, "agent"], [2, "user"]]);
    expect(s.takeUserEdits()).toEqual(["a.md"]);
    expect(s.takeUserEdits()).toEqual([]);
  });

  test("a stale base hash is refused with 409", () => {
    const { store: s, dir } = store();
    writeFileSync(join(dir, "a.md"), "one");
    s.snapshot("a.md", "agent", null);
    expect(() => s.write("a.md", new TextEncoder().encode("two"), "user", "deadbeef")).toThrow(/changed/);
  });

  test("restore writes the old content as a new version and removes nothing", () => {
    const { store: s, dir } = store();
    writeFileSync(join(dir, "a.md"), "one");
    s.snapshot("a.md", "agent", null);
    writeFileSync(join(dir, "a.md"), "two");
    s.snapshot("a.md", "agent", null);
    const v = s.restore("a.md", 1);
    expect(v).toMatchObject({ n: 3, author: "restore" });
    expect(readFileSync(join(dir, "a.md"), "utf8")).toBe("one");
    expect(s.versions("a.md")).toHaveLength(3);
    expect(() => s.restore("a.md", 9)).toThrow(/no such version/);
  });
});

describe("path safety and size", () => {
  test("names with separators or a leading dot are refused, a symlink is not served, a link out of the folder is refused", () => {
    const { store: s, dir } = store();
    writeFileSync(join(base, "secret.txt"), "secret");
    symlinkSync(join(base, "secret.txt"), join(dir, "link.txt"));
    for (const bad of ["../x", "a/b", ".versions", ".hidden"]) {
      expect(() => s.read(bad)).toThrow();
    }
    expect(() => s.read("link.txt")).toThrow(/symbolic/);
    expect(s.list().map((a) => a.name)).not.toContain("link.txt");
    expect(() => s.read("a.md", 1)).toThrow();
  });

  test("a preview above 5 MB answers 413, the plain read still works", () => {
    const { store: s, dir } = store();
    writeFileSync(join(dir, "big.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    expect(() => s.read("big.txt", undefined, true)).toThrow(/larger than 5 MB/);
    expect(s.read("big.txt").bytes.length).toBe(5 * 1024 * 1024 + 1);
  });

  test("an external candidate must be an opted-in type inside the folder", () => {
    const settings = { track_external: true, extensions: ["html"] };
    const folder = join(base, "proj");
    expect(externalCandidate("Write", { file_path: join(folder, "a.html") }, folder, settings)).toBe(join(folder, "a.html"));
    expect(externalCandidate("write", { path: "sub/b.html" }, folder, settings)).toBe(join(folder, "sub/b.html"));
    expect(externalCandidate("Write", { file_path: join(folder, "a.py") }, folder, settings)).toBeNull();
    expect(externalCandidate("Write", { file_path: "/etc/a.html" }, folder, settings)).toBeNull();
    expect(externalCandidate("Write", { file_path: join(folder, "../x/a.html") }, folder, settings)).toBeNull();
    expect(externalCandidate("Read", { file_path: join(folder, "a.html") }, folder, settings)).toBeNull();
    expect(externalCandidate("Write", { file_path: join(folder, "a.html") }, folder, { ...settings, track_external: false })).toBeNull();
  });

  test("mirror copies a file of the folder and refuses a link that leaves it", () => {
    const { store: s, dir } = store();
    const folder = join(base, "mirror-folder");
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "a.html"), "<b>x</b>");
    writeFileSync(join(base, "outside.html"), "nope");
    symlinkSync(join(base, "outside.html"), join(folder, "out.html"));
    expect(s.mirror(join(folder, "a.html"), folder)).toBe("a.html");
    expect(readFileSync(join(dir, "a.html"), "utf8")).toBe("<b>x</b>");
    expect(s.mirror(join(folder, "out.html"), folder)).toBeNull();
    expect(existsSync(join(dir, "out.html"))).toBe(false);
  });
});

describe("scan and watcher", () => {
  test("scan reports created, updated and deleted once each", () => {
    const { store: s, dir } = store();
    writeFileSync(join(dir, "a.md"), "one");
    expect(s.scan("c", "t1").map((e) => [e.name, e.change, e.version])).toEqual([["a.md", "created", 1]]);
    expect(s.scan("c", "t1")).toEqual([]);
    writeFileSync(join(dir, "a.md"), "two");
    expect(s.scan("c", "t2").map((e) => [e.change, e.version, e.turn])).toEqual([["updated", 2, "t2"]]);
    writeFileSync(join(base, "gone"), "");
    Bun.spawnSync(["mv", join(dir, "a.md"), join(base, "moved-a.md")]);
    expect(s.scan("c", null).map((e) => [e.name, e.change])).toEqual([["a.md", "deleted"]]);
    expect(s.scan("c", null)).toEqual([]);
    writeFileSync(join(dir, "a.md"), "two");
    expect(s.scan("c", null).map((e) => e.change)).toEqual(["created"]);
  });

  test("fs.watch pushes one debounced event per burst of writes", async () => {
    const { store: s, dir } = store();
    const hub = new ArtifactHub();
    const events: ArtifactEvent[] = [];
    hub.attach("c", s, (e) => events.push(e));
    hub.retain("c");
    hub.setTurn("c", "msg-9");
    writeFileSync(join(dir, "a.html"), "<p>1</p>");
    writeFileSync(join(dir, "a.html"), "<p>12</p>");
    await Bun.sleep(600);
    expect(events.map((e) => [e.change, e.version, e.turn])).toEqual([["created", 1, "msg-9"]]);
    writeFileSync(join(dir, "a.html"), "<p>3</p>");
    await Bun.sleep(600);
    expect(events.at(-1)).toMatchObject({ change: "updated", version: 2 });
    hub.release("c");
    writeFileSync(join(dir, "a.html"), "<p>4</p>");
    await Bun.sleep(400);
    expect(events).toHaveLength(2);
  });
});

describe("API", () => {
  const servers: TestServerHandle[] = [];
  afterEach(() => {
    for (const x of servers.splice(0)) x.stop();
    delete process.env.ORCH_CHAT_CLAUDE_BIN;
  });
  const folder = join(base, "root/proj");
  mkdirSync(folder, { recursive: true });
  const PROFILES = { settings: { chat_roots: [join(base, "root")] }, models: { "m-a": { slug: "alpha", harnesses: ["claude"] } }, profiles: { main: { harness: "claude", model: "m-a" } } };
  async function boot(bin = "fake-claude.ts"): Promise<{ srv: TestServerHandle; id: string; dir: string }> {
    process.env.ORCH_CHAT_CLAUDE_BIN = resolve(import.meta.dir, "testing", bin);
    const srv = startTestServer();
    srv.home.write("profiles.json", JSON.stringify(PROFILES));
    servers.push(srv);
    const res = await srv.api("/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ harness: "claude", profile: "main", cwd: folder }) });
    const id = ((await res.json()) as { id: string }).id;
    const dir = join(folder, ".orch/chats", id, "artifacts");
    mkdirSync(dir, { recursive: true });
    return { srv, id, dir };
  }
  const put = (srv: TestServerHandle, id: string, name: string, body: unknown, method = "PUT", sub = ""): Promise<Response> =>
    srv.api(`/api/chats/${id}/artifacts/${encodeURIComponent(name)}${sub}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

  test("list, content, versions, save, restore, 413 and traversal", async () => {
    const { srv, id, dir } = await boot();
    writeFileSync(join(dir, "n.md"), "# one");
    const list = (await (await srv.api(`/api/chats/${id}/artifacts`)).json()) as { items: Array<{ name: string; kind: string; version: number }> };
    expect(list.items).toMatchObject([{ name: "n.md", kind: "markdown", version: 1 }]);
    const content = await srv.api(`/api/chats/${id}/artifacts/n.md/content`);
    expect(await content.text()).toBe("# one");
    expect(content.headers.get("content-type")).toContain("text/plain");
    expect(content.headers.get("content-security-policy")).toContain("sandbox");
    const saved = (await (await put(srv, id, "n.md", { content: "# two" })).json()) as { version: { n: number; author: string } };
    expect(saved.version).toMatchObject({ n: 2, author: "user" });
    const versions = (await (await srv.api(`/api/chats/${id}/artifacts/n.md/versions`)).json()) as { items: unknown[] };
    expect(versions.items).toHaveLength(2);
    expect(await (await srv.api(`/api/chats/${id}/artifacts/n.md/content?version=1`)).text()).toBe("# one");
    const restored = (await (await put(srv, id, "n.md", { version: 1 }, "POST", "/restore")).json()) as { version: { n: number; author: string } };
    expect(restored.version).toMatchObject({ n: 3, author: "restore" });
    expect(readFileSync(join(dir, "n.md"), "utf8")).toBe("# one");
    expect((await put(srv, id, "n.md", { content: "x", base_hash: "nope" })).status).toBe(409);
    expect((await srv.api(`/api/chats/${id}/artifacts/..%2Fx/content`)).status).toBe(400);
    expect((await srv.api(`/api/chats/${id}/artifacts/n.md/content?version=7`)).status).toBe(404);
    writeFileSync(join(dir, "big.txt"), Buffer.alloc(5 * 1024 * 1024 + 1, 97));
    expect((await srv.api(`/api/chats/${id}/artifacts/big.txt/content?preview=1`)).status).toBe(413);
    expect((await srv.api(`/api/chats/${id}/artifacts/big.txt/content?download=1`)).status).toBe(200);
    expect(readdirSync(dir)).toContain(".versions");
  });

  test("a sandboxed view address needs no token, carries a sandbox CSP that blocks the network, and names one artifact", async () => {
    const { srv, id, dir } = await boot();
    writeFileSync(join(dir, "p.html"), "<script>document.title='x'</script><p>hi</p>");
    writeFileSync(join(dir, "i.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const issued = (await (await put(srv, id, "p.html", {}, "POST", "/view")).json()) as { url: string };
    expect(issued.url).toMatch(/^\/artifact-view\/[0-9a-f]{48}$/);
    const res = await srv.api(issued.url, {}, false);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<p>hi</p>");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(res.headers.get("set-cookie")).toBeNull();
    const svg = await srv.api((((await (await put(srv, id, "i.svg", {}, "POST", "/view")).json()) as { url: string }).url), {}, false);
    expect(svg.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg.headers.get("content-security-policy")).toStartWith("sandbox;");
    expect((await srv.api("/artifact-view/nope", {}, false)).status).toBe(404);
    expect((await put(srv, id, "../x", {}, "POST", "/view")).status).toBe(400);
    expect((await srv.api(issued.url, { headers: { Host: "evil.example" } }, false)).status).toBe(403);
  });

  test("settings round trip", async () => {
    const { srv } = await boot();
    const first = (await (await srv.api("/api/artifact-settings")).json()) as { track_external: boolean; extensions: string[] };
    expect(first.track_external).toBe(true);
    const next = (await (await srv.api("/api/artifact-settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ track_external: false, extensions: [".HTML", "md", "bad ext"] }) })).json()) as { extensions: string[] };
    expect(next.extensions).toEqual(["html", "md"]);
  });

  test("end to end: an agent writes an HTML artifact in two steps, SSE carries both versions, the next turn knows a user edit", async () => {
    const { srv, id } = await boot("fake-claude-artifact.ts");
    const seen: Array<{ change: string; version: number; turn: string | null }> = [];
    const abort = new AbortController();
    const stream = await srv.api(`/api/chats/${id}/events`, { signal: abort.signal });
    const reader = stream.body!.getReader();
    const pump = (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return;
        buf += dec.decode(value);
        for (const frame of buf.split("\n\n").slice(0, -1)) {
          if (frame.includes("event: artifact")) seen.push(JSON.parse(frame.split("data: ")[1]!) as (typeof seen)[number]);
        }
        buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
      }
    })();
    const send = (content: string): Promise<Response> => srv.api(`/api/chats/${id}/messages`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
    expect((await send("make it ARTIFACT")).status).toBeLessThan(300);
    for (let i = 0; i < 100 && !seen.some((e) => e.version === 2); i++) await Bun.sleep(100);
    abort.abort();
    await pump;
    expect(seen.map((e) => [e.change, e.version])).toEqual([["created", 1], ["updated", 2]]);
    expect(seen[0]?.turn).toMatch(/^msg-/);
    const versions = (await (await srv.api(`/api/chats/${id}/artifacts/page.html/versions`)).json()) as { items: Array<{ turn: string | null }> };
    expect(versions.items).toHaveLength(2);
    expect(await (await srv.api(`/api/chats/${id}/artifacts/page.html/content?version=1`)).text()).toBe("<h1>First</h1>");
  });
});
