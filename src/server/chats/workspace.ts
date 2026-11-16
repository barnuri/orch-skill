import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, sep } from "node:path";
import { deflateRawSync } from "node:zlib";

import { detectMime, isInlineImage } from "./uploads";

export type Scope = "chat" | "folder";
export type Area = "knowledge" | "artifacts";
export const AREAS: readonly Area[] = ["knowledge", "artifacts"];
export const MAX_WORKSPACE_UPLOAD: number = 20 * 1024 * 1024;
export const MAX_MEMORY_BYTES: number = 200 * 1024;
export const INSTRUCTION_LIMIT: number = 1000;

export class WorkspaceError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface WorkspaceFile {
  name: string;
  size: number;
  modified: string;
  type: string;
  preview: "image" | "text" | "none";
}

export interface ChatMeta {
  id: string;
  title: string;
  created_at: string;
  harness: string;
  updated_at: string;
}

const MEMORY = "MEMORY.md";

/** A bare file name: no separators, control characters or leading dot (so `.trash` and dotfiles stay out of reach). */
export function cleanName(raw: string): string {
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (name === "" || name.startsWith(".") || /[\\/\u0000-\u001f]/.test(name) || name.length > 255) {
    throw new WorkspaceError(400, `invalid file name: ${JSON.stringify(raw.slice(0, 80))}`);
  }
  return name;
}

export function isArea(value: string): value is Area {
  return (AREAS as readonly string[]).includes(value);
}

function previewOf(type: string): WorkspaceFile["preview"] {
  if (isInlineImage(type)) {
    return "image";
  }
  if ((type.startsWith("text/") && type !== "text/html") || type === "application/json" || type === "application/xml") {
    return "text";
  }
  return "none";
}

function inside(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/** The `<cwd>/.orch` folder (or the orch home's chat data folder): one code path for the chat and the folder scope. */
export class Workspace {
  /**
   * @param root       directory of this scope
   * @param fence      the folder that must contain `root` after symlinks are resolved (null: the orch home, trusted)
   */
  constructor(readonly scope: Scope, readonly root: string, private readonly fence: string | null, private readonly meta: ChatMeta | null = null) {}

  exists(): boolean {
    return existsSync(this.root);
  }

  /** Creates the layout. Idempotent. Throws 400 when `.orch` was replaced by a link that leaves the folder. */
  ensure(movedFrom?: string): void {
    if (this.fence !== null) {
      const orch = join(this.fence, ".orch");
      mkdirSync(orch, { recursive: true });
      const ignore = join(orch, ".gitignore");
      if (!existsSync(ignore)) {
        writeFileSync(ignore, "*\n");
      }
    }
    mkdirSync(this.root, { recursive: true });
    for (const area of AREAS) {
      mkdirSync(join(this.root, area), { recursive: true });
    }
    if (this.fence !== null && !inside(realpathSync(this.fence), realpathSync(this.root))) {
      throw new WorkspaceError(400, "the workspace path leaves the folder");
    }
    if (this.meta !== null) {
      const file = join(this.root, "chat.json");
      let previous: { moved_from?: string } = {};
      try {
        previous = JSON.parse(readFileSync(file, "utf8")) as { moved_from?: string };
      } catch {
        previous = {};
      }
      const moved = movedFrom ?? previous.moved_from;
      const next = JSON.stringify({ id: this.meta.id, title: this.meta.title, created: this.meta.created_at, harness: this.meta.harness, ...(moved === undefined ? {} : { moved_from: moved }) }, null, 2);
      if (!existsSync(file) || readFileSync(file, "utf8") !== next) {
        writeFileSync(file, next);
      }
      if (this.fence !== null) {
        indexUpsert(this.fence, { id: this.meta.id, title: this.meta.title, updated_at: this.meta.updated_at }, true);
      }
    }
  }

  movedFrom(): string | null {
    try {
      const v = (JSON.parse(readFileSync(join(this.root, "chat.json"), "utf8")) as { moved_from?: unknown }).moved_from;
      return typeof v === "string" ? v : null;
    } catch {
      return null;
    }
  }

  private memoryPath(): string {
    return join(this.root, MEMORY);
  }

  readMemory(): { content: string; exists: boolean; modified: string | null } {
    const file = this.memoryPath();
    if (!existsSync(file)) {
      return { content: "", exists: false, modified: null };
    }
    const stat = lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new WorkspaceError(400, "MEMORY.md is not a regular file");
    }
    return { content: readFileSync(file, "utf8"), exists: true, modified: stat.mtime.toISOString() };
  }

  writeMemory(content: string): void {
    if (Buffer.byteLength(content) > MAX_MEMORY_BYTES) {
      throw new WorkspaceError(413, `memory is larger than ${MAX_MEMORY_BYTES / 1024} KB`);
    }
    this.ensure();
    const file = this.memoryPath();
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) {
      throw new WorkspaceError(400, "MEMORY.md is a symbolic link");
    }
    writeFileSync(file, content);
  }

  list(area: Area): WorkspaceFile[] {
    const dir = join(this.root, area);
    if (!existsSync(dir)) {
      return [];
    }
    const out: WorkspaceFile[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) {
        continue;
      }
      const stat = lstatSync(join(dir, entry));
      if (stat.isSymbolicLink() || !stat.isFile()) {
        continue;
      }
      const type = detectMime(new Uint8Array(0), entry);
      out.push({ name: entry, size: stat.size, modified: stat.mtime.toISOString(), type, preview: previewOf(type) });
    }
    return out.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
  }

  /** The real path of an existing file: it is a regular file, not a link, and inside this scope's area folder. */
  resolveFile(area: Area, rawName: string): string {
    const name = cleanName(rawName);
    const dir = join(this.root, area);
    const file = join(dir, name);
    if (!existsSync(dir) || !existsSync(file) && !isDangling(file)) {
      throw new WorkspaceError(404, "no such file");
    }
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) {
      throw new WorkspaceError(400, "symbolic links are not served");
    }
    if (!stat.isFile() || !inside(realpathSync(dir), realpathSync(file))) {
      throw new WorkspaceError(404, "no such file");
    }
    return file;
  }

  serve(area: Area, name: string, download: boolean): Response {
    const file = this.resolveFile(area, name);
    const bytes = new Uint8Array(readFileSync(file));
    const type = detectMime(bytes, basename(file));
    const preview = previewOf(type);
    const inline = !download && preview !== "none";
    const contentType = preview === "text" ? "text/plain; charset=utf-8" : preview === "image" ? type : "application/octet-stream";
    return new Response(bytes, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(basename(file))}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  }

  save(area: Area, rawName: string, bytes: Uint8Array): WorkspaceFile {
    const name = cleanName(rawName);
    if (bytes.length === 0) {
      throw new WorkspaceError(400, `${name}: file is empty`);
    }
    if (bytes.length > MAX_WORKSPACE_UPLOAD) {
      throw new WorkspaceError(413, `${name}: larger than ${MAX_WORKSPACE_UPLOAD / (1024 * 1024)} MB`);
    }
    this.ensure();
    const target = join(this.root, area, name);
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new WorkspaceError(400, "a symbolic link has this name");
    }
    writeFileSync(target, bytes);
    return this.list(area).find((f) => f.name === name) as WorkspaceFile;
  }

  /** Moves the file into `.trash/`; nothing is ever deleted. */
  trash(area: Area, name: string): void {
    const file = this.resolveFile(area, name);
    const trash = join(this.root, ".trash");
    mkdirSync(trash, { recursive: true });
    renameSync(file, join(trash, `${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${area}-${basename(file)}`));
  }

  /** A zip of the whole scope (memory, knowledge, artifacts, chat.json), without `.trash`. */
  zip(): Uint8Array {
    const entries: Array<{ name: string; data: Uint8Array; mtime: Date }> = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === ".trash" || (entry === "browser" && basename(dir) === ".orch")) {
          continue;
        }
        const full = join(dir, entry);
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          walk(full, `${prefix}${entry}/`);
        } else if (stat.isFile()) {
          entries.push({ name: `${prefix}${entry}`, data: new Uint8Array(readFileSync(full)), mtime: stat.mtime });
        }
      }
    };
    if (existsSync(this.root)) {
      walk(this.root, "");
    }
    return buildZip(entries);
  }
}

function isDangling(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function dosTime(d: Date): { time: number; date: number } {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: (Math.max(d.getFullYear() - 1980, 0) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

/** A zip writer (deflate, no zip64): the files of one workspace are far below 4 GB. */
export function buildZip(entries: ReadonlyArray<{ name: string; data: Uint8Array; mtime: Date }>): Uint8Array {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const packed = deflateRawSync(e.data);
    const crc = Bun.hash.crc32(e.data) >>> 0;
    const { time, date } = dosTime(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(8, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(packed.length, 20);
    head.writeUInt32LE(e.data.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(head, name);
    offset += 30 + name.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

// ---- the folder's chat index ----

interface IndexEntry {
  id: string;
  title: string;
  updated: string;
}

function indexFile(cwd: string): string {
  return join(cwd, ".orch", "chats", "index.json");
}

function readIndex(cwd: string): IndexEntry[] {
  try {
    const parsed = JSON.parse(readFileSync(indexFile(cwd), "utf8")) as { chats?: IndexEntry[] };
    return Array.isArray(parsed.chats) ? parsed.chats : [];
  } catch {
    return [];
  }
}

function writeIndex(cwd: string, chats: IndexEntry[]): void {
  const file = indexFile(cwd);
  mkdirSync(join(cwd, ".orch", "chats"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ chats }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Adds or updates a chat in the folder's index. Without `create` it only edits an index that already exists. */
export function indexUpsert(cwd: string, chat: { id: string; title: string; updated_at: string }, create: boolean): void {
  if (!create && !existsSync(indexFile(cwd))) {
    return;
  }
  const rest = readIndex(cwd).filter((e) => e.id !== chat.id);
  writeIndex(cwd, [...rest, { id: chat.id, title: chat.title, updated: chat.updated_at }].sort((a, b) => b.updated.localeCompare(a.updated)));
}

export function indexRemove(cwd: string, chatId: string): void {
  if (!existsSync(indexFile(cwd))) {
    return;
  }
  writeIndex(cwd, readIndex(cwd).filter((e) => e.id !== chatId));
}

// ---- the agent's instruction block ----

export interface InstructionInput {
  shared: string | null;
  chat: string;
  projectInstructions: string;
}

/** Under INSTRUCTION_LIMIT characters: the project instructions are cut to fit, the rules never are. */
export function instructionBlock({ shared, chat, projectInstructions }: InstructionInput): string {
  const roots = shared === null ? `Workspace: ${chat}/` : `Workspace. Shared by every chat of this folder: ${shared}/ . This chat: ${chat}/ .`;
  const layout = "Each has MEMORY.md, knowledge/ (reference files) and artifacts/ (generated files).";
  const read = shared === null ? "Read MEMORY.md before answering if it exists." : "Read both MEMORY.md files before answering if they exist (shared first).";
  const write =
    shared === null
      ? "At the end of a turn, if you learned a durable fact or decision, update MEMORY.md in place (under 200 lines)."
      : "At the end of a turn, if you learned a durable fact or decision, update this chat's MEMORY.md in place (under 200 lines). Write to the shared MEMORY.md only for facts every chat of this folder should know: one short line each, with the date. Never edit another chat's directory under .orch/chats/; read its chat.json and MEMORY.md only when the user asks.";
  const put = "Put generated files in artifacts/.";
  const base = `[${roots} ${layout} ${read} ${write} ${put}`;
  const closing = "]";
  const room = INSTRUCTION_LIMIT - base.length - closing.length - " Project instructions: ".length - 1;
  const extra = projectInstructions.trim().replace(/\s+/g, " ");
  const tail = extra === "" || room < 20 ? "" : ` Project instructions: ${extra.length > room ? `${extra.slice(0, room - 1)}…` : extra}`;
  return `${base}${tail}${closing}`;
}

/** A change in either memory file is a reason to send the block again. */
export function memoryFingerprint(...memories: string[]): string {
  const h = createHash("sha1");
  for (const m of memories) {
    h.update(m).update("\u0000");
  }
  return h.digest("hex");
}
