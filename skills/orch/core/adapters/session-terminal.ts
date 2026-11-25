// Find the terminal of an interactive opencode session that the shared service does not know (a `--standalone` TUI runs a
// private server). Terminal ids come from the registering process (recorded at register) or from the TUI process itself.
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface TerminalRef {
  hc_terminal?: string;
  hc_socket?: string;
  herdr_pane?: string;
  herdr_socket?: string;
}

export const hasTerminal = (t: TerminalRef | null | undefined): boolean => !!t && !!(t.hc_terminal || (t.herdr_pane && t.herdr_socket));

/** The terminal ids of a process environment; hc first, herdr second. */
export function terminalFromEnv(env: Record<string, string | undefined>): TerminalRef {
  const t: TerminalRef = {};
  if (env.HC_TERMINAL_ID) { t.hc_terminal = env.HC_TERMINAL_ID; if (env.HC_TERMINAL_SOCKET) t.hc_socket = env.HC_TERMINAL_SOCKET; }
  if (env.HERDR_PANE_ID && env.HERDR_SOCKET_PATH) { t.herdr_pane = env.HERDR_PANE_ID; t.herdr_socket = env.HERDR_SOCKET_PATH; }
  return t;
}

async function run(cmd: string[]): Promise<string> {
  try {
    const p = Bun.spawn(cmd, { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const t = setTimeout(() => p.kill("SIGKILL"), 8000);
    const text = await new Response(p.stdout).text();
    await p.exited;
    clearTimeout(t);
    return text;
  } catch { return ""; }
}

export interface ProcRow { pid: number; command: string }

export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), command: m[2]! });
  }
  return rows;
}

const isTui = (cmd: string): boolean => /(^|\/)opencode(\s|$)/.test(cmd) && !/\s(serve|run|pty|daemon|api|service)(\s|$)/.test(cmd);

/** TUI processes whose arguments carry `-s <session>` or `--session <session>` (also `--session=<id>`). */
export function tuiBySessionArg(rows: ProcRow[], session: string): ProcRow[] {
  const re = new RegExp(`(\\s-s|\\s--session)(\\s+|=)${session}(\\s|$)`);
  return rows.filter((r) => isTui(r.command) && re.test(r.command));
}

/** The env of a process (`ps -E`): only the terminal variables, as written in the command column. */
export function envFromPsE(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const m of text.matchAll(/(?:^|\s)(HC_TERMINAL_ID|HC_TERMINAL_SOCKET|HERDR_PANE_ID|HERDR_SOCKET_PATH)=(\S+)/g)) env[m[1]!] = m[2]!;
  return env;
}

function dbPath(): string {
  return process.env.ORCH_OPENCODE_DB || join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "opencode.db");
}

function sessionDirectory(session: string): string {
  const f = dbPath();
  if (!existsSync(f)) return "";
  try {
    const db = new Database(f, { readonly: true });
    try { return String((db.query("select directory from session where id = ?").get(session) as any)?.directory ?? ""); } finally { db.close(); }
  } catch { return ""; }
}

async function cwdOf(pid: number): Promise<string> {
  const out = await run(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"]);
  return /^n(.*)$/m.exec(out)?.[1] ?? "";
}

export type Found = { terminal: TerminalRef; pid: number; how: string; standalone: boolean } | { terminal: null; why: string };

/** Find the TUI of `session` and read its terminal from its environment. */
export async function findSessionTerminal(session: string): Promise<Found> {
  const rows = parsePs(await run(["ps", "-axo", "pid=,command="]));
  let how = "session argument";
  let hits = tuiBySessionArg(rows, session);
  if (hits.length === 0) {
    const dir = sessionDirectory(session);
    if (dir) {
      const tuis = rows.filter((r) => isTui(r.command));
      const same: ProcRow[] = [];
      for (const r of tuis) if ((await cwdOf(r.pid)) === dir) same.push(r);
      // Only a single TUI in that directory is unambiguous; several could be any session.
      if (same.length === 1) { hits = same; how = "session directory"; }
    }
  }
  if (hits.length !== 1) return { terminal: null, why: hits.length ? "several TUI processes match the session" : "no TUI process found for the session" };
  const t = terminalFromEnv(envFromPsE(await run(["ps", "-E", "-p", String(hits[0]!.pid), "-o", "command="])));
  return hasTerminal(t) ? { terminal: t, pid: hits[0]!.pid, how, standalone: /\s--standalone(\s|$)/.test(hits[0]!.command) } : { terminal: null, why: `TUI process ${hits[0]!.pid} has no terminal in its environment` };
}
