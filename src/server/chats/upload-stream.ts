import { createHash } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { MAX_FILE_BYTES, MAX_MESSAGE_BYTES, MAX_UPLOAD_REQUEST_BYTES } from "./limits";

export class StreamError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Staged {
  filename: string | null;
  /** File on disk holding the bytes; the caller moves or removes it. */
  tmp: string;
  size: number;
  sha256: string;
  /** First bytes, enough to sniff the type. */
  head: Uint8Array;
}

const HEAD_BYTES = 16;
const MAX_HEADER_BYTES = 16 * 1024;
const enc = new TextEncoder();

function indexOf(hay: Uint8Array, needle: Uint8Array, from: number = 0): number {
  return Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).indexOf(needle, from);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) {
    return b;
  }
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function boundaryOf(type: string): string | null {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(type);
  return m === null ? null : ((m[1] ?? m[2]) as string);
}

function filenameOf(headers: string): string | null | undefined {
  // undefined: not a file part; null: a file part without a usable name
  const disposition = /^content-disposition:(.*)$/im.exec(headers)?.[1] ?? "";
  const star = /filename\*=UTF-8''([^;\s]+)/i.exec(disposition)?.[1];
  if (star !== undefined) {
    try {
      return decodeURIComponent(star);
    } catch {
      return star;
    }
  }
  const quoted = /filename="((?:[^"\\]|\\.)*)"/i.exec(disposition)?.[1];
  if (quoted !== undefined) {
    return quoted.replace(/\\(.)/g, "$1").replace(/%22/g, '"');
  }
  return /filename=([^;\s]+)/i.exec(disposition)?.[1] ?? undefined;
}

class Sink {
  private readonly hash = createHash("sha256");
  private readonly writer: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  size = 0;
  head: Uint8Array = new Uint8Array(0);

  constructor(readonly tmp: string, readonly filename: string | null) {
    this.writer = Bun.file(tmp).writer();
  }

  write(chunk: Uint8Array): void {
    if (chunk.length === 0) {
      return;
    }
    this.size += chunk.length;
    if (this.head.length < HEAD_BYTES) {
      this.head = concat(this.head, chunk.slice(0, HEAD_BYTES - this.head.length));
    }
    this.hash.update(chunk);
    this.writer.write(chunk);
  }

  async finish(): Promise<Staged> {
    await this.writer.end();
    return { filename: this.filename, tmp: this.tmp, size: this.size, sha256: this.hash.digest("hex"), head: this.head };
  }
}

export interface StageOptions {
  /** Bytes of this message's files that are already stored and unsent. */
  alreadyPending: number;
  stagingDir: string;
}

/**
 * Reads the request body as a stream and writes every file part to `stagingDir`, hashing as it goes.
 * Memory use is one chunk plus a small carry-over, never the whole upload. The per-file and
 * per-message limits are enforced while reading, so an oversize body stops early. On any error every
 * staged file is removed.
 */
export async function stageUploads(req: Request, opts: StageOptions): Promise<Staged[]> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_UPLOAD_REQUEST_BYTES) {
    throw new StreamError(413, `request is larger than ${MAX_UPLOAD_REQUEST_BYTES} bytes`);
  }
  mkdirSync(opts.stagingDir, { recursive: true, mode: 0o700 });
  const staged: Staged[] = [];
  let open: Sink | null = null;
  let counter = 0;
  const newSink = (filename: string | null): Sink => new Sink(join(opts.stagingDir, `up-${process.pid}-${Date.now()}-${(counter += 1)}`), filename);
  let total = opts.alreadyPending;
  const account = (sink: Sink, n: number): void => {
    total += n;
    if (sink.size + n > MAX_FILE_BYTES) {
      throw new StreamError(413, `${sink.filename ?? "file"}: larger than ${MAX_FILE_BYTES} bytes`);
    }
    if (total > MAX_MESSAGE_BYTES) {
      throw new StreamError(413, `attachments of one message may total ${MAX_MESSAGE_BYTES} bytes`);
    }
  };
  try {
    const type = req.headers.get("content-type") ?? "";
    const body = req.body;
    if (body === null) {
      return staged;
    }
    let read = 0;
    const reader = body.getReader();
    const next = async (): Promise<Uint8Array | null> => {
      const r = await reader.read();
      if (r.done) {
        return null;
      }
      read += r.value.length;
      if (read > MAX_UPLOAD_REQUEST_BYTES) {
        throw new StreamError(413, `request is larger than ${MAX_UPLOAD_REQUEST_BYTES} bytes`);
      }
      return r.value;
    };

    if (!type.toLowerCase().startsWith("multipart/form-data")) {
      const sink = newSink(null);
      open = sink;
      for (let chunk = await next(); chunk !== null; chunk = await next()) {
        account(sink, chunk.length);
        sink.write(chunk);
      }
      staged.push(await sink.finish());
      open = null;
      return staged;
    }

    const boundary = boundaryOf(type);
    if (boundary === null) {
      throw new StreamError(400, "malformed multipart body");
    }
    const delimiter = enc.encode(`\r\n--${boundary}`);
    let buf: Uint8Array = enc.encode("\r\n");
    let state: "preamble" | "after-delim" | "headers" | "body" | "end" = "preamble";
    let eof = false;
    let sink: Sink | null = null;
    while (state !== "end") {
      if (state === "preamble" || state === "body") {
        const at = indexOf(buf, delimiter);
        if (at >= 0) {
          if (state === "body" && sink !== null) {
            account(sink, at);
            sink.write(buf.subarray(0, at));
            staged.push(await sink.finish());
            open = null;
            sink = null;
          } else if (state === "body") {
            // a non-file part: its bytes are dropped
          }
          buf = buf.subarray(at + delimiter.length);
          state = "after-delim";
          continue;
        }
        // keep the tail that could still be the start of a delimiter
        const keep = Math.min(buf.length, delimiter.length - 1);
        const emit = buf.length - keep;
        if (state === "body" && sink !== null && emit > 0) {
          account(sink, emit);
          sink.write(buf.subarray(0, emit));
        }
        buf = buf.subarray(emit);
      } else if (state === "after-delim") {
        if (buf.length >= 2) {
          const t = String.fromCharCode(buf[0] as number, buf[1] as number);
          if (t === "--") {
            state = "end";
            continue;
          }
          if (t !== "\r\n") {
            throw new StreamError(400, "malformed multipart body");
          }
          buf = buf.subarray(2);
          state = "headers";
          continue;
        }
      } else {
        const at = indexOf(buf, enc.encode("\r\n\r\n"));
        if (at >= 0) {
          const name = filenameOf(new TextDecoder().decode(buf.subarray(0, at)));
          buf = buf.subarray(at + 4);
          if (name !== undefined) {
            sink = newSink(name);
            open = sink;
          }
          state = "body";
          continue;
        }
        if (buf.length > MAX_HEADER_BYTES) {
          throw new StreamError(400, "malformed multipart body");
        }
      }
      if (eof) {
        throw new StreamError(400, "malformed multipart body");
      }
      const chunk = await next();
      if (chunk === null) {
        eof = true;
      } else {
        buf = concat(buf, chunk);
      }
    }
    void reader.cancel().catch(() => undefined);
    return staged;
  } catch (err) {
    if (open !== null) {
      await open.finish().catch(() => undefined);
    }
    for (const file of staged) {
      rmSync(file.tmp, { force: true });
    }
    if (open !== null) {
      rmSync(open.tmp, { force: true });
    }
    throw err;
  }
}
