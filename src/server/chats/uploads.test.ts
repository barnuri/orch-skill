import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { TempHome } from "../test-support/temp-home";
import { MAX_FILE_BYTES, MAX_MESSAGE_BYTES } from "./limits";
import { ChatStore } from "./store";
import { agentPathFor, blobPath, cleanFilename, detectMime, saveUploads, serveAttachment, UploadError } from "./uploads";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function setup(): { home: TempHome; store: ChatStore; chatId: string } {
  const home = TempHome.create();
  const store = new ChatStore(":memory:");
  return { home, store, chatId: store.createChat({ title: "t", harness: "claude", profile: "p" }).id };
}

function multipart(files: Array<[string, Uint8Array | string]>): Request {
  const form = new FormData();
  for (const [name, data] of files) {
    form.append("file", new File([data as BlobPart], name));
  }
  return new Request("http://x/upload", { method: "POST", body: form });
}

async function reject(work: Promise<unknown>): Promise<UploadError> {
  try {
    await work;
  } catch (err) {
    expect(err).toBeInstanceOf(UploadError);
    return err as UploadError;
  }
  throw new Error("expected a rejection");
}

describe("mime detection", () => {
  test("images by magic bytes, whatever the name says", () => {
    expect(detectMime(PNG, "photo.txt")).toBe("image/png");
    expect(detectMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), "x")).toBe("image/jpeg");
    expect(detectMime(new TextEncoder().encode("GIF89a.."), "x")).toBe("image/gif");
    expect(detectMime(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "), "x")).toBe("image/webp");
  });
  test("others by extension; a fake image extension is opaque", () => {
    expect(detectMime(new TextEncoder().encode("hi"), "notes.md")).toBe("text/markdown");
    expect(detectMime(new TextEncoder().encode("hi"), "a.png")).toBe("application/octet-stream");
    expect(detectMime(new TextEncoder().encode("hi"), "noext")).toBe("application/octet-stream");
  });
});

describe("filenames", () => {
  test.each(["../../etc/passwd", "a/b.txt", "a\\b.txt", "..", ".", "", "x\u0000.txt", "a\nb"])("refuses %p", (name) => {
    expect(() => cleanFilename(name)).toThrow(UploadError);
  });
  test("keeps ordinary names, including unicode and spaces", () => {
    expect(cleanFilename(" my file (1).txt ")).toBe("my file (1).txt");
    expect(cleanFilename("תמונה.png")).toBe("תמונה.png");
  });
});

describe("saveUploads", () => {
  test("stores content-addressed, deduplicates, keeps the original name", async () => {
    const { home, store, chatId } = setup();
    const rows = await saveUploads(store, home.path, chatId, multipart([["a.txt", "same"], ["b.txt", "same"], ["c.txt", "other"]]));
    expect(rows.map((r) => r.filename)).toEqual(["a.txt", "b.txt", "c.txt"]);
    expect(rows[0]?.sha256).toBe(rows[1]?.sha256 as string);
    const sha = rows[0]?.sha256 as string;
    expect(readFileSync(blobPath(home.path, sha), "utf8")).toBe("same");
    expect(blobPath(home.path, sha)).toContain(join("chats", "files", sha.slice(0, 2), sha));
    expect(readdirSync(join(home.path, "chats", "files", sha.slice(0, 2))).filter((n) => n.includes("tmp"))).toEqual([]);
    expect(rows[0]?.mime).toBe("text/plain");
  });

  test("a raw pasted blob uses X-Filename, or a generated name", async () => {
    const { home, store, chatId } = setup();
    const named = await saveUploads(store, home.path, chatId, new Request("http://x", { method: "POST", body: PNG, headers: { "X-Filename": encodeURIComponent("shot 1.png") } }));
    expect([named[0]?.filename, named[0]?.mime]).toEqual(["shot 1.png", "image/png"]);
    const anon = await saveUploads(store, home.path, chatId, new Request("http://x", { method: "POST", body: PNG }));
    expect(anon[0]?.filename).toMatch(/^pasted-\d{14}\.png$/);
  });

  test("a traversal name rejects the whole request and stores nothing", async () => {
    const { home, store, chatId } = setup();
    const err = await reject(saveUploads(store, home.path, chatId, new Request("http://x", { method: "POST", body: "x", headers: { "X-Filename": "..%2F..%2Fescape" } })));
    expect(err.status).toBe(400);
    expect(store.pendingAttachments(chatId)).toEqual([]);
    expect(existsSync(join(home.path, "chats", "files"))).toBe(false);
  });

  test("empty file and empty request are 400", async () => {
    const { home, store, chatId } = setup();
    expect((await reject(saveUploads(store, home.path, chatId, multipart([["e.txt", ""]])))).status).toBe(400);
    expect((await reject(saveUploads(store, home.path, chatId, multipart([])))).status).toBe(400);
  });

  test("a file over the per-file limit is 413", async () => {
    const { home, store, chatId } = setup();
    const err = await reject(saveUploads(store, home.path, chatId, multipart([["big.bin", new Uint8Array(MAX_FILE_BYTES + 1)]])));
    expect(err.status).toBe(413);
  });

  test("the per-message total counts files uploaded earlier and not yet sent", async () => {
    const { home, store, chatId } = setup();
    const chunk = new Uint8Array(MAX_FILE_BYTES);
    const ok = (n: number): Promise<unknown> => saveUploads(store, home.path, chatId, multipart([[`f${n}.bin`, chunk.fill(n)]]));
    for (let i = 1; i <= 4; i++) {
      await ok(i);
    }
    expect(store.pendingSize(chatId)).toBe(4 * MAX_FILE_BYTES);
    expect(MAX_MESSAGE_BYTES).toBe(4 * MAX_FILE_BYTES);
    expect((await reject(ok(5))).status).toBe(413);
  });

  test("an announced body larger than the request limit is refused before reading", async () => {
    const { home, store, chatId } = setup();
    const req = new Request("http://x", { method: "POST", body: "x", headers: { "Content-Length": String(MAX_MESSAGE_BYTES * 2) } });
    expect((await reject(saveUploads(store, home.path, chatId, req))).status).toBe(413);
  });

  test("the agent gets an absolute path that keeps the real filename", async () => {
    const { home, store, chatId } = setup();
    const [row] = await saveUploads(store, home.path, chatId, multipart([["report.txt", "data"]]));
    const path = agentPathFor(home.path, row as never);
    expect(path.startsWith("/")).toBe(true);
    expect(path.endsWith("report.txt")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("data");
    expect(agentPathFor(home.path, row as never)).toBe(path);
  });
});

describe("serving", () => {
  test("images inline, everything else a download, always nosniff", async () => {
    const { home, store, chatId } = setup();
    const [img, txt, html] = await saveUploads(store, home.path, chatId, multipart([["p.png", PNG], ["n.txt", "hello"], ["x.html", "<script>alert(1)</script>"]]));
    const a = serveAttachment(home.path, img as never);
    expect(a.headers.get("content-type")).toBe("image/png");
    expect(a.headers.get("content-disposition")).toStartWith("inline;");
    const b = serveAttachment(home.path, txt as never);
    expect(b.headers.get("content-disposition")).toStartWith("attachment;");
    expect(await b.text()).toBe("hello");
    const c = serveAttachment(home.path, html as never);
    expect(c.headers.get("content-disposition")).toStartWith("attachment;");
    for (const res of [a, b, c]) {
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    }
  });

  test("a non-ASCII filename is encoded in the header", async () => {
    const { home, store, chatId } = setup();
    const [row] = await saveUploads(store, home.path, chatId, multipart([["דוח.txt", "x"]]));
    const header = serveAttachment(home.path, row as never).headers.get("content-disposition") as string;
    expect(header).toContain("filename*=UTF-8''%D7%93%D7%95%D7%97.txt");
  });
});
