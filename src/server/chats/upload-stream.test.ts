import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { TempHome } from "../test-support/temp-home";
import { MAX_FILE_BYTES } from "./limits";
import { ChatStore } from "./store";
import { saveUploads, UploadError } from "./uploads";

const enc = new TextEncoder();

function streamOf(parts: Uint8Array[], onPull?: (total: number) => void): ReadableStream<Uint8Array> {
  let i = 0;
  let total = 0;
  return new ReadableStream({
    pull(controller) {
      const part = parts[i++];
      if (part === undefined) {
        controller.close();
        return;
      }
      total += part.length;
      onPull?.(total);
      controller.enqueue(part);
    },
  });
}

function multipartBytes(files: Array<[string, Uint8Array]>, boundary = "XyZ"): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [name, bytes] of files) {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

function slices(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.subarray(i, i + size));
  }
  return out;
}

function setup(): { store: ChatStore; home: string; chatId: string } {
  const home = TempHome.create();
  const store = new ChatStore(join(home.path, "chats.db"));
  const chat = store.createChat({ title: "t", harness: "claude", profile: "p" });
  return { store, home: home.path, chatId: chat.id };
}
const leftovers = (home: string): string[] => (existsSync(join(home, "chats", "tmp")) ? readdirSync(join(home, "chats", "tmp")) : []);

describe("streamed uploads (F4)", () => {
  test("a multipart body split into tiny chunks, with a near-boundary bytes inside the data, is stored intact", async () => {
    const { store, home, chatId } = setup();
    const a = Buffer.concat([enc.encode("line1\r\n--Xy"), new Uint8Array([0, 1, 2, 255]), enc.encode("\r\n--Xz\r\n")]);
    const b = enc.encode("second file");
    const req = new Request("http://x/up", {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=XyZ" },
      body: streamOf(slices(multipartBytes([["a.bin", a], ["b.txt", b]]), 7)), duplex: "half",
    } as RequestInit);
    const rows = await saveUploads(store, home, chatId, req);
    expect(rows.map((r) => [r.filename, r.size])).toEqual([["a.bin", a.length], ["b.txt", b.length]]);
    expect(readFileSync(join(home, rows[0]?.rel_path as string))).toEqual(a);
    expect(readFileSync(join(home, rows[1]?.rel_path as string)).toString()).toBe("second file");
    expect(leftovers(home)).toEqual([]);
    store.close();
  });

  test("an oversize file in a chunked body (no Content-Length) is refused early and leaves nothing", async () => {
    const { store, home, chatId } = setup();
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    const head = enc.encode('--B\r\nContent-Disposition: form-data; name="f"; filename="big.bin"\r\n\r\n');
    const parts = [head, ...Array.from({ length: 40 }, () => chunk), enc.encode("\r\n--B--\r\n")];
    let pulled = 0;
    const req = new Request("http://x/up", {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=B" },
      body: streamOf(parts, (n) => { pulled = n; }), duplex: "half",
    } as RequestInit);
    const err = await saveUploads(store, home, chatId, req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadError);
    expect((err as UploadError).status).toBe(413);
    expect(pulled).toBeLessThan(MAX_FILE_BYTES + 4 * 1024 * 1024);
    expect(leftovers(home)).toEqual([]);
    expect(store.pendingSize(chatId)).toBe(0);
    store.close();
  });

  test("a raw body is hashed and stored without a multipart parse; a broken multipart is 400 and cleaned", async () => {
    const { store, home, chatId } = setup();
    const raw = new Request("http://x/up", { method: "POST", headers: { "x-filename": "n.txt" }, body: streamOf(slices(enc.encode("hello raw"), 3)), duplex: "half" } as RequestInit);
    const [row] = await saveUploads(store, home, chatId, raw);
    expect([row?.filename, row?.size]).toEqual(["n.txt", 9]);
    const broken = new Request("http://x/up", {
      method: "POST", headers: { "content-type": "multipart/form-data; boundary=B" },
      body: streamOf([enc.encode('--B\r\nContent-Disposition: form-data; name="f"; filename="x.txt"\r\n\r\nabc')]), duplex: "half",
    } as RequestInit);
    const err = await saveUploads(store, home, chatId, broken).catch((e: unknown) => e);
    expect((err as UploadError).status).toBe(400);
    expect(leftovers(home)).toEqual([]);
    store.close();
  });
});
