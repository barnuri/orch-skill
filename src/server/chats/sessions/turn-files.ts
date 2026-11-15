import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentEvent } from "./types";

/**
 * Restart-safe chat turns. A turn's harness runs detached (own session and process group, stdio on files, not on
 * pipes to the server) with its output appended to `<home>/chats/turns/<id>.jsonl` (stdout), `<id>.err` (stderr)
 * and an `<id>.exit` file (the exit code) written by a tiny `sh` wrapper when the process ends. The server only
 * tails those files, so a dashboard restart neither cuts the answer nor loses it.
 */
export type ParserKind = "claude" | "opencode" | "plain";

export interface TurnMeta {
  pid: number;
  harness: string;
  parser: ParserKind;
  session_id: string | null;
  chat_id: string;
  message_id: string;
  model: string | null;
  started: string;
  /** Bytes of the output file already turned into events (always a line or character boundary). */
  offset: number;
}

export interface TurnPaths { id: string; dir: string; out: string; err: string; exit: string; meta: string; input: string }

export interface TurnParser {
  /** `lines`: feed whole lines; `text`: feed raw text pieces. */
  readonly mode: "lines" | "text";
  feed(piece: string): AgentEvent[];
  /** Events that close the turn once the process has exited with `code`. */
  end(code: number, stderr: string): AgentEvent[];
  sessionId(): string | null;
}

export const TURN_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const POLL_MS = 40;
const READ_CHUNK = 1 << 20;
const KILL_GRACE_MS = 1500;

export function turnsDir(home: string): string {
  return join(home, "chats", "turns");
}

export function turnPaths(home: string, id: string): TurnPaths {
  const dir = turnsDir(home);
  return { id, dir, out: join(dir, `${id}.jsonl`), err: join(dir, `${id}.err`), exit: join(dir, `${id}.exit`), meta: join(dir, `${id}.meta.json`), input: join(dir, `${id}.in`) };
}

export function writeMeta(paths: TurnPaths, meta: TurnMeta): void {
  const tmp = `${paths.meta}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta), { mode: 0o600 });
  renameSync(tmp, paths.meta);
}

export function readMeta(path: string): TurnMeta | null {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as Partial<TurnMeta>;
    if (typeof doc.pid === "number" && typeof doc.message_id === "string" && typeof doc.chat_id === "string" && typeof doc.parser === "string") {
      return { harness: "", session_id: null, model: null, started: "", offset: 0, ...doc } as TurnMeta;
    }
  } catch {
    // unreadable or half written: not a turn we can adopt
  }
  return null;
}

/** Every readable turn meta in the folder, with its paths. */
export function listTurns(home: string): Array<{ paths: TurnPaths; meta: TurnMeta }> {
  const dir = turnsDir(home);
  const out: Array<{ paths: TurnPaths; meta: TurnMeta }> = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".meta.json")) {
      continue;
    }
    const meta = readMeta(join(dir, name));
    if (meta !== null) {
      out.push({ paths: turnPaths(home, name.slice(0, -".meta.json".length)), meta });
    }
  }
  return out;
}

export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    return false;
  }
}

/** SIGTERM the process group, then SIGKILL after a grace period. */
export async function killGroup(pid: number): Promise<void> {
  signalGroup(pid, "SIGTERM");
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline && signalGroup(pid, 0)) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (signalGroup(pid, 0)) {
    signalGroup(pid, "SIGKILL");
    const end = Date.now() + 2000;
    while (Date.now() < end && signalGroup(pid, 0)) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

const WRAPPER = 'out=$1; err=$2; ex=$3; in=$4; shift 4; "$@" <"$in" >>"$out" 2>>"$err"; code=$?; echo "$code" >"$ex.tmp" && mv "$ex.tmp" "$ex"';

export interface StartOptions {
  home: string;
  id: string;
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  /** Prompt text the process reads on stdin, or null for no stdin. */
  stdin: string | null;
  meta: Omit<TurnMeta, "pid" | "started" | "offset">;
}

/** Starts the harness detached and writes its meta file. Throws when the process cannot be spawned. */
export function startTurn(o: StartOptions): { paths: TurnPaths; meta: TurnMeta } {
  const paths = turnPaths(o.home, o.id);
  mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  writeFileSync(paths.out, "", { mode: 0o600 });
  writeFileSync(paths.err, "", { mode: 0o600 });
  if (o.stdin !== null) {
    writeFileSync(paths.input, o.stdin, { mode: 0o600 });
  }
  const proc = Bun.spawn(["/bin/sh", "-c", WRAPPER, "orch-turn", paths.out, paths.err, paths.exit, o.stdin === null ? "/dev/null" : paths.input, ...o.cmd], {
    cwd: o.cwd, env: o.env, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true,
  });
  proc.unref();
  const meta: TurnMeta = { ...o.meta, pid: proc.pid, started: new Date().toISOString(), offset: 0 };
  writeMeta(paths, meta);
  return { paths, meta };
}

export type TailEnd = { kind: "exit"; code: number; stderr: string } | { kind: "interrupted" } | { kind: "aborted" };

export interface TailOptions {
  signal: AbortSignal;
  /** Events built from bytes before this offset were already delivered once; they go to `onReplay` instead. */
  replayUntil?: number;
  onReplay?: (ev: AgentEvent) => void;
  pollMs?: number;
}

/** Length of the longest prefix of `buf` that does not end inside a UTF-8 sequence. */
function completeUtf8Length(buf: Buffer): number {
  let i = buf.length - 1;
  let back = 0;
  while (i >= 0 && back < 4 && ((buf[i] as number) & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i < 0) {
    return buf.length;
  }
  const lead = buf[i] as number;
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return back + 1 < need ? i : buf.length;
}

function stderrTail(paths: TurnPaths): string {
  try {
    return readFileSync(paths.err, "utf8").slice(-2000);
  } catch {
    return "";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Follows the turn's output file and yields the events `parser` makes of it. The file is always read from the
 * start (so the parser's state is complete); bytes before `replayUntil` go to `onReplay`. `meta.offset` and the
 * session id are persisted as the file is consumed. Returns how the turn ended; the caller decides what
 * events that means.
 */
export async function* tailTurn(paths: TurnPaths, meta: TurnMeta, parser: TurnParser, opts: TailOptions): AsyncGenerator<AgentEvent, TailEnd> {
  const replayUntil = opts.replayUntil ?? 0;
  const poll = opts.pollMs ?? POLL_MS;
  let consumed = 0;
  let carry: Buffer = Buffer.alloc(0);
  let fileOffset = 0;
  let savedOffset = meta.offset;
  let savedSession = meta.session_id;
  let fd: number | null = null;
  const deliver = function* (events: AgentEvent[], upTo: number): Generator<AgentEvent> {
    for (const ev of events) {
      if (upTo <= replayUntil) {
        opts.onReplay?.(ev);
      } else {
        yield ev;
      }
    }
  };
  try {
    for (;;) {
      if (opts.signal.aborted) {
        return { kind: "aborted" };
      }
      const exited = existsSync(paths.exit);
      if (fd === null && existsSync(paths.out)) {
        fd = openSync(paths.out, "r");
      }
      const size = fd === null ? 0 : statSync(paths.out).size;
      if (fd !== null && size > fileOffset) {
        const room = fileOffset < replayUntil ? replayUntil - fileOffset : READ_CHUNK;
        const want = Math.min(size - fileOffset, READ_CHUNK, room);
        const chunk = Buffer.alloc(want);
        const got = readSync(fd, chunk, 0, want, fileOffset);
        fileOffset += got;
        const buf = Buffer.concat([carry, chunk.subarray(0, got)]);
        const cut = parser.mode === "lines" ? buf.lastIndexOf(10) + 1 : completeUtf8Length(buf);
        carry = buf.subarray(cut);
        if (cut > 0) {
          consumed += cut;
          yield* deliver(parser.feed(buf.subarray(0, cut).toString("utf8")), consumed);
          const sid = parser.sessionId();
          if ((consumed > replayUntil && consumed > savedOffset) || (sid !== null && sid !== savedSession)) {
            savedOffset = Math.max(savedOffset, consumed);
            savedSession = sid ?? savedSession;
            try {
              writeMeta(paths, { ...meta, offset: savedOffset, session_id: savedSession });
            } catch {
              // the folder vanished: tailing still works
            }
          }
        }
        continue;
      }
      if (exited) {
        if (carry.length > 0 && parser.mode === "lines") {
          const rest = carry.toString("utf8");
          carry = Buffer.alloc(0);
          consumed += Buffer.byteLength(rest);
          yield* deliver(parser.feed(`${rest}\n`), consumed);
        }
        const code = Number.parseInt(readFileSync(paths.exit, "utf8").trim(), 10);
        return { kind: "exit", code: Number.isFinite(code) ? code : 1, stderr: stderrTail(paths) };
      }
      if (!isAlive(meta.pid)) {
        // The wrapper writes the exit file before it ends: look once more after a short wait.
        await sleep(150, opts.signal);
        if (existsSync(paths.exit) || opts.signal.aborted) {
          continue;
        }
        if (fd !== null && statSync(paths.out).size > fileOffset) {
          continue;
        }
        return { kind: "interrupted" };
      }
      await sleep(poll, opts.signal);
    }
  } finally {
    if (fd !== null) {
      closeSync(fd);
    }
  }
}

/** Shell exit codes for "command not found" (127) and "found but not executable" (126): the agent never ran, so its stderr ("No such file or directory") says nothing about the session. */
export function agentCouldNotRun(code: number): boolean {
  return code === 126 || code === 127;
}

export const INTERRUPTED_TEXT = "interrupted: the agent process ended without finishing (the dashboard restarted or the process was killed). The partial answer is kept; send another message to continue the same session.";

/** `tailTurn` plus the closing events: the parser's own at exit, `interrupted` when the process vanished, nothing when aborted. */
export async function* turnEvents(paths: TurnPaths, meta: TurnMeta, parser: TurnParser, opts: TailOptions): AsyncGenerator<AgentEvent> {
  const end = yield* tailTurn(paths, meta, parser, opts);
  if (end.kind === "exit") {
    yield* parser.end(end.code, end.stderr);
  } else if (end.kind === "interrupted") {
    yield { type: "interrupted", message: INTERRUPTED_TEXT };
  }
}

/** Handle for the one running turn of a session: its process group and its tailer's abort switch. */
export class TurnHandle {
  private abort: AbortController | null = null;
  private pid: number | null = null;
  stopping = false;

  begin(): AbortSignal {
    this.abort = new AbortController();
    this.stopping = false;
    return this.abort.signal;
  }

  attachPid(pid: number): void {
    this.pid = pid;
  }

  end(): void {
    this.abort = null;
    this.pid = null;
  }

  /** Kills the process and ends the tailer; the turn is over. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.abort?.abort();
    const pid = this.pid;
    if (pid !== null) {
      await killGroup(pid);
    }
  }

  /** Stops following the process but leaves it running (server shutdown or restart). */
  detach(): void {
    this.abort?.abort();
  }
}

export function trashPaths(home: string, files: string[]): void {
  const existing = files.filter((f) => existsSync(f));
  if (existing.length === 0) {
    return;
  }
  try {
    const r = Bun.spawnSync(["trash", ...existing], { stdout: "ignore", stderr: "ignore" });
    if (r.exitCode === 0) {
      return;
    }
  } catch {
    // no trash binary: move aside
  }
  const dir = join(home, ".trash", `chats-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  for (const f of existing) {
    try {
      renameSync(f, join(dir, f.split("/").pop() as string));
    } catch {
      // leave it
    }
  }
}

/** Trashes turn files older than `maxAgeMs`; a turn whose process still runs and has no exit file is never touched. Returns how many turns. */
export function sweepTurnFiles(home: string, maxAgeMs: number = TURN_KEEP_MS, nowMs: number = Date.now()): number {
  const dir = turnsDir(home);
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const byId = new Map<string, string[]>();
  for (const name of names) {
    const id = name.split(".")[0] as string;
    byId.set(id, [...(byId.get(id) ?? []), join(dir, name)]);
  }
  let removed = 0;
  for (const [id, files] of byId) {
    const paths = turnPaths(home, id);
    let newest = 0;
    for (const f of files) {
      try {
        newest = Math.max(newest, statSync(f).mtimeMs);
      } catch {
        // gone
      }
    }
    if (nowMs - newest <= maxAgeMs) {
      continue;
    }
    const meta = readMeta(paths.meta);
    if (meta !== null && !existsSync(paths.exit) && isAlive(meta.pid)) {
      continue;
    }
    trashPaths(home, files);
    removed++;
  }
  return removed;
}
