import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { type ArtifactEvent, type ArtifactInfo, type ArtifactSettings, type ArtifactVersion, DEFAULT_EXTERNAL_EXTENSIONS, extOf, kindOf, PREVIEW_LIMIT } from "../../shared/artifacts";
import { cleanName, type Workspace, WorkspaceError } from "./workspace";

export const DEBOUNCE_MS = 150;
const VERSIONS = ".versions";

export const hashOf = (bytes: Uint8Array): string => createHash("sha1").update(bytes).digest("hex").slice(0, 12);

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/**
 * The versions of the files in one `artifacts/` folder: every distinct content is snapshotted as
 * `.versions/<name>/<n>` with `<n>.json` (time, turn id, author). The file itself is read through the
 * workspace's path checks (regular file, real path inside the folder, no symlink).
 */
export class ArtifactStore {
  constructor(private readonly ws: Workspace) {}

  get dir(): string {
    return join(this.ws.root, "artifacts");
  }

  private versionDir(name: string): string {
    return join(this.dir, VERSIONS, cleanName(name));
  }

  private state(name: string): { deleted?: boolean; source?: string } {
    return readJson(join(this.versionDir(name), "state.json"), {});
  }

  private setState(name: string, patch: { deleted?: boolean; source?: string }): void {
    mkdirSync(this.versionDir(name), { recursive: true });
    writeFileSync(join(this.versionDir(name), "state.json"), JSON.stringify({ ...this.state(name), ...patch }));
  }

  versions(name: string): ArtifactVersion[] {
    const dir = this.versionDir(name);
    if (!existsSync(dir)) {
      return [];
    }
    return readdirSync(dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => readJson<ArtifactVersion | null>(join(dir, f), null))
      .filter((v): v is ArtifactVersion => v !== null)
      .sort((a, b) => a.n - b.n);
  }

  private latest(name: string): ArtifactVersion | null {
    return this.versions(name).at(-1) ?? null;
  }

  /** Snapshots the file when its content is new. Returns the new version, or null when nothing changed. */
  snapshot(name: string, author: ArtifactVersion["author"], turn: string | null): ArtifactVersion | null {
    const file = this.ws.resolveFile("artifacts", name);
    const bytes = new Uint8Array(readFileSync(file));
    const hash = hashOf(bytes);
    const last = this.latest(name);
    if (last !== null && last.hash === hash) {
      return null;
    }
    const n = (last?.n ?? 0) + 1;
    const dir = this.versionDir(name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, String(n)), bytes);
    const meta: ArtifactVersion = { n, at: new Date().toISOString(), turn, author, hash, size: bytes.length };
    writeFileSync(join(dir, `${n}.json`), JSON.stringify(meta));
    return meta;
  }

  info(name: string): ArtifactInfo {
    const file = this.ws.resolveFile("artifacts", name);
    const stat = statSync(file);
    const hash = hashOf(new Uint8Array(readFileSync(file)));
    const versions = this.versions(name);
    const match = [...versions].reverse().find((v) => v.hash === hash);
    return { name, kind: kindOf(name), size: stat.size, modified: stat.mtime.toISOString(), version: match?.n ?? versions.at(-1)?.n ?? 0, hash };
  }

  list(): ArtifactInfo[] {
    return this.ws.list("artifacts").map((f) => this.info(f.name));
  }

  /** The bytes of the current file (`version` undefined) or of a snapshot. `preview` refuses more than 5 MB. */
  read(name: string, version?: number, preview = false): { bytes: Uint8Array; version: number; hash: string } {
    let bytes: Uint8Array;
    let n: number;
    if (version === undefined) {
      const file = this.ws.resolveFile("artifacts", name);
      if (preview && statSync(file).size > PREVIEW_LIMIT) {
        throw new WorkspaceError(413, `${name}: larger than ${PREVIEW_LIMIT / (1024 * 1024)} MB, download it instead`);
      }
      bytes = new Uint8Array(readFileSync(file));
      n = this.info(name).version;
    } else {
      if (!Number.isInteger(version) || version < 1 || !this.versions(name).some((v) => v.n === version)) {
        throw new WorkspaceError(404, "no such version");
      }
      const file = join(this.versionDir(name), String(version));
      if (preview && statSync(file).size > PREVIEW_LIMIT) {
        throw new WorkspaceError(413, `${name}: larger than ${PREVIEW_LIMIT / (1024 * 1024)} MB, download it instead`);
      }
      bytes = new Uint8Array(readFileSync(file));
      n = version;
    }
    return { bytes, version: n, hash: hashOf(bytes) };
  }

  /** A write by the user (the editor) or a restore: the file changes and a version of that author is recorded. */
  write(name: string, bytes: Uint8Array, author: "user" | "restore", baseHash?: string): ArtifactVersion | null {
    const clean = cleanName(name);
    if (baseHash !== undefined && existsSync(join(this.dir, clean)) && this.info(clean).hash !== baseHash) {
      throw new WorkspaceError(409, "the artifact changed since you opened it");
    }
    this.snapshotExisting(clean);
    this.ws.save("artifacts", clean, bytes);
    const v = this.snapshot(clean, author, null);
    if (author === "user" && v !== null) {
      const pending = readJson<string[]>(join(this.dir, VERSIONS, ".user-edits.json"), []);
      if (!pending.includes(clean)) {
        writeFileSync(join(this.dir, VERSIONS, ".user-edits.json"), JSON.stringify([...pending, clean]));
      }
    }
    return v;
  }

  /** Records the file as it is before a user write overwrites it, so version 1 of an unseen file is not lost. */
  private snapshotExisting(name: string): void {
    if (existsSync(join(this.dir, name))) {
      this.snapshot(name, "agent", null);
    }
  }

  restore(name: string, version: number): ArtifactVersion | null {
    const { bytes } = this.read(name, version);
    return this.write(name, bytes, "restore");
  }

  /** Names the user edited since the last call; cleared by the call. */
  takeUserEdits(): string[] {
    const file = join(this.dir, VERSIONS, ".user-edits.json");
    const names = readJson<string[]>(file, []);
    if (names.length > 0) {
      writeFileSync(file, "[]");
    }
    return names;
  }

  /** Compares every file with its latest snapshot and returns the events (created, updated, deleted) for the differences. */
  scan(chatId: string, turn: string | null): ArtifactEvent[] {
    const out: ArtifactEvent[] = [];
    if (!existsSync(this.dir)) {
      return out;
    }
    for (const f of this.ws.list("artifacts")) {
      const hadVersions = this.versions(f.name).length > 0;
      const wasDeleted = this.state(f.name).deleted === true;
      let v: ArtifactVersion | null = null;
      try {
        v = this.snapshot(f.name, "agent", turn);
      } catch {
        continue;
      }
      if (v !== null || wasDeleted) {
        const cur = v ?? (this.latest(f.name) as ArtifactVersion);
        if (wasDeleted) {
          this.setState(f.name, { deleted: false });
        }
        out.push({ chat_id: chatId, name: f.name, change: hadVersions && !wasDeleted ? "updated" : hadVersions ? "created" : "created", version: cur.n, kind: kindOf(f.name), hash: cur.hash, turn });
      }
    }
    const root = join(this.dir, VERSIONS);
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        if (name.startsWith(".") || existsSync(join(this.dir, name)) || this.state(name).deleted === true) {
          continue;
        }
        const last = this.latest(name);
        if (last !== null) {
          this.setState(name, { deleted: true });
          out.push({ chat_id: chatId, name, change: "deleted", version: last.n, kind: kindOf(name), hash: last.hash, turn });
        }
      }
    }
    return out;
  }

  /** Copies a file an agent wrote elsewhere under the chat folder into `artifacts/` (the watcher then versions it). */
  mirror(source: string, folder: string): string | null {
    let real: string;
    try {
      if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isFile()) {
        return null;
      }
      real = realpathSync(source);
      const root = realpathSync(folder);
      if (real !== root && !real.startsWith(root + sep)) {
        return null;
      }
    } catch {
      return null;
    }
    if (statSync(real).size > PREVIEW_LIMIT * 4) {
      return null;
    }
    this.ws.ensure();
    const base = cleanName(basename(real));
    let name = base;
    const owner = (n: string): string | undefined => this.state(n).source;
    if (existsSync(join(this.dir, name)) && owner(name) !== real) {
      name = cleanName(`${basename(dirname(real))}-${base}`);
    }
    if (existsSync(join(this.dir, name)) && owner(name) !== real && owner(name) !== undefined) {
      return null;
    }
    this.setState(name, { source: real });
    copyFileSync(real, join(this.dir, name));
    return name;
  }
}

export function readSettings(home: string): ArtifactSettings {
  const raw = readJson<Partial<ArtifactSettings>>(join(home, "chats", "artifact-settings.json"), {});
  return {
    track_external: raw.track_external ?? true,
    extensions: Array.isArray(raw.extensions) ? raw.extensions.filter((e): e is string => typeof e === "string").map((e) => e.replace(/^\./, "").toLowerCase()) : [...DEFAULT_EXTERNAL_EXTENSIONS],
  };
}

export function writeSettings(home: string, next: ArtifactSettings): ArtifactSettings {
  const clean: ArtifactSettings = {
    track_external: next.track_external,
    extensions: [...new Set(next.extensions.map((e) => e.replace(/^\./, "").toLowerCase()).filter((e) => /^[a-z0-9]{1,8}$/.test(e)))],
  };
  mkdirSync(join(home, "chats"), { recursive: true });
  writeFileSync(join(home, "chats", "artifact-settings.json"), JSON.stringify(clean, null, 2));
  return clean;
}

/** The path a Write or Edit tool call targets when it is an opted-in artifact type inside the chat folder, else null. */
export function externalCandidate(toolName: string, input: unknown, folder: string, settings: ArtifactSettings): string | null {
  if (!settings.track_external || !["write", "edit", "multiedit"].includes(toolName.toLowerCase()) || typeof input !== "object" || input === null) {
    return null;
  }
  const r = input as Record<string, unknown>;
  const raw = [r.file_path, r.filePath, r.path].find((v): v is string => typeof v === "string" && v !== "");
  if (raw === undefined) {
    return null;
  }
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(folder, raw);
  const root = resolve(folder);
  if (!abs.startsWith(root + sep) || abs.includes(`${sep}.orch${sep}`) || abs.includes(`${sep}node_modules${sep}`) || !settings.extensions.includes(extOf(abs))) {
    return null;
  }
  return abs;
}

interface Watched {
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  store: ArtifactStore;
  turn: string | null;
  emit: (ev: ArtifactEvent) => void;
  listeners: number;
}

/** One fs.watch per chat with live listeners; a change is debounced 150 ms, then every file is compared with its snapshot. */
export class ArtifactHub {
  private readonly watched = new Map<string, Watched>();

  /** Starts (or refreshes) the watch. Without an `artifacts/` folder there is nothing to watch yet: `scan` retries. */
  attach(chatId: string, store: ArtifactStore, emit: (ev: ArtifactEvent) => void): void {
    const w = this.watched.get(chatId) ?? { watcher: null, timer: null, store, turn: null, emit, listeners: 0 };
    w.store = store;
    w.emit = emit;
    this.watched.set(chatId, w);
    if (w.watcher === null && existsSync(store.dir)) {
      try {
        w.watcher = watch(store.dir, { persistent: false }, () => this.schedule(chatId));
        w.watcher.on("error", () => {
          w.watcher?.close();
          w.watcher = null;
        });
      } catch {
        w.watcher = null;
      }
    }
  }

  retain(chatId: string): void {
    const w = this.watched.get(chatId);
    if (w !== undefined) {
      w.listeners += 1;
    }
  }

  release(chatId: string): void {
    const w = this.watched.get(chatId);
    if (w !== undefined && --w.listeners <= 0) {
      this.close(chatId);
    }
  }

  setTurn(chatId: string, turn: string | null): void {
    const w = this.watched.get(chatId);
    if (w !== undefined) {
      w.turn = turn;
    }
  }

  private schedule(chatId: string): void {
    const w = this.watched.get(chatId);
    if (w === undefined) {
      return;
    }
    if (w.timer !== null) {
      clearTimeout(w.timer);
    }
    w.timer = setTimeout(() => {
      w.timer = null;
      this.scan(chatId);
    }, DEBOUNCE_MS);
  }

  /** Compares now and emits. Also (re)attaches the watcher, because the folder may have been created since. */
  scan(chatId: string): void {
    const w = this.watched.get(chatId);
    if (w === undefined) {
      return;
    }
    this.attach(chatId, w.store, w.emit);
    for (const ev of w.store.scan(chatId, w.turn)) {
      w.emit(ev);
    }
  }

  close(chatId: string): void {
    const w = this.watched.get(chatId);
    if (w !== undefined) {
      w.watcher?.close();
      if (w.timer !== null) {
        clearTimeout(w.timer);
      }
      this.watched.delete(chatId);
    }
  }

  closeAll(): void {
    for (const id of [...this.watched.keys()]) {
      this.close(id);
    }
  }
}
