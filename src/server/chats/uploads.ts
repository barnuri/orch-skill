import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, join } from "node:path";

import { type Staged, StreamError, stageUploads } from "./upload-stream";
import type { ChatStore } from "./store";
import type { AttachmentRow } from "./types";

export class UploadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const EXT_MIME: Record<string, string> = {
  txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", pdf: "application/pdf",
  html: "text/html", htm: "text/html", xml: "application/xml", yaml: "text/yaml", yml: "text/yaml", log: "text/plain",
  js: "text/javascript", ts: "text/plain", py: "text/x-python", sh: "text/x-shellscript", svg: "image/svg+xml",
  zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
};
const INLINE_IMAGES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export function isInlineImage(mime: string): boolean {
  return INLINE_IMAGES.has(mime);
}

function sniffImage(b: Uint8Array): string | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

/** Magic bytes decide for images; anything else uses its extension. An image extension without image bytes is opaque. */
export function detectMime(bytes: Uint8Array, filename: string): string {
  const sniffed = sniffImage(bytes);
  if (sniffed !== null) {
    return sniffed;
  }
  const ext = filename.includes(".") ? (filename.split(".").pop() as string).toLowerCase() : "";
  const byExt = EXT_MIME[ext];
  if (byExt === undefined || (byExt.startsWith("image/") && byExt !== "image/svg+xml")) {
    return "application/octet-stream";
  }
  return byExt;
}

/** A filename is a bare name: no separators, no NUL or control characters, not `.` or `..`. */
export function cleanFilename(raw: string): string {
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (name === "" || name === "." || name === ".." || /[\\/\u0000-\u001f]/.test(name)) {
    throw new UploadError(400, `invalid filename: ${JSON.stringify(raw.slice(0, 80))}`);
  }
  if (name.length > 255) {
    throw new UploadError(400, "filename is longer than 255 characters");
  }
  return name;
}

export function blobPath(home: string, sha: string): string {
  return join(home, "chats", "files", sha.slice(0, 2), sha);
}

function pastedName(head: Uint8Array): string {
  const mime = sniffImage(head);
  return `pasted-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}.${mime === null ? "bin" : IMAGE_EXT[mime]}`;
}

/**
 * Streams the request body to disk (see stageUploads), validates every file, then moves each into the
 * content-addressed store. A rejected request leaves nothing behind. Nothing holds a whole upload in memory.
 */
export async function saveUploads(store: ChatStore, home: string, chatId: string, req: Request): Promise<AttachmentRow[]> {
  let staged: Staged[];
  try {
    staged = await stageUploads(req, { alreadyPending: store.pendingSize(chatId), stagingDir: join(home, "chats", "tmp") });
  } catch (err) {
    if (err instanceof StreamError) {
      throw new UploadError(err.status, err.message);
    }
    throw new UploadError(400, "malformed multipart body");
  }
  const discard = (): void => {
    for (const file of staged) {
      rmSync(file.tmp, { force: true });
    }
  };
  try {
    if (staged.length === 0) {
      throw new UploadError(400, "no files in the request");
    }
    const named = staged.map((file) => {
      let filename: string;
      if (file.filename === null) {
        const header = req.headers.get("x-filename");
        if (header === null) {
          filename = pastedName(file.head);
        } else {
          let decoded = header;
          try {
            decoded = decodeURIComponent(header);
          } catch {
            // keep it as sent
          }
          filename = cleanFilename(decoded);
        }
      } else {
        filename = cleanFilename(file.filename);
      }
      return { file, filename };
    });
    for (const { file, filename } of named) {
      if (file.size === 0) {
        throw new UploadError(400, `${filename}: file is empty`);
      }
    }
    return named.map(({ file, filename }) => {
      const target = blobPath(home, file.sha256);
      if (existsSync(target)) {
        rmSync(file.tmp, { force: true });
      } else {
        mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
        chmodSync(file.tmp, 0o600);
        renameSync(file.tmp, target);
      }
      return store.addAttachment({
        chat_id: chatId, filename, mime: detectMime(file.head, filename), size: file.size,
        sha256: file.sha256, rel_path: join("chats", "files", file.sha256.slice(0, 2), file.sha256),
      });
    });
  } catch (err) {
    discard();
    throw err;
  }
}

/** The path the agent reads: the blob under its real filename, so tools see the right extension. */
export function agentPathFor(home: string, row: AttachmentRow): string {
  const dir = join(home, "chats", "links", row.id);
  const link = join(dir, basename(row.filename));
  if (!existsSync(link)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    symlinkSync(blobPath(home, row.sha256), link);
  }
  return link;
}

function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
}

export function serveAttachment(home: string, row: AttachmentRow): Response {
  const file = Bun.file(blobPath(home, row.sha256));
  const inline = isInlineImage(row.mime);
  return new Response(file, {
    headers: {
      "Content-Type": row.mime,
      "Content-Length": String(row.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName(row.filename)}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=86400",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    },
  });
}

/**
 * Deletes an attachment's row and, when no other row has the same content, its blob; the agent-facing
 * link folder goes too. Returns false when the attachment is unknown or already belongs to a message.
 */
export function deleteUnattached(store: ChatStore, home: string, id: string): boolean {
  const row = store.dropUnattached(id);
  if (row === null) {
    return false;
  }
  rmSync(join(home, "chats", "links", row.id), { recursive: true, force: true });
  if (!store.sha256InUse(row.sha256)) {
    rmSync(blobPath(home, row.sha256), { force: true });
  }
  return true;
}

export const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/** Startup sweep: uploads nobody sent within 24 hours. Returns how many were removed. */
export function sweepUnattached(store: ChatStore, home: string, nowMs: number = Date.now()): number {
  let removed = 0;
  for (const row of store.unattachedBefore(new Date(nowMs - SWEEP_AGE_MS).toISOString())) {
    if (deleteUnattached(store, home, row.id)) {
      removed++;
    }
  }
  return removed;
}
