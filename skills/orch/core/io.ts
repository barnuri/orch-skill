// Per-call output and environment. A command run by the CLI writes to the process; the same command
// run for the server socket is captured, with the caller's env and home, through AsyncLocalStorage.
import { AsyncLocalStorage } from "node:async_hooks";
import { orchHome } from "./state/home.ts";

export interface IoStore {
  env: NodeJS.ProcessEnv;
  stdout: string[];
  stderr: string[];
}

const store = new AsyncLocalStorage<IoStore>();

export function out(s: string): void {
  const st = store.getStore();
  if (st) st.stdout.push(s);
  else process.stdout.write(s);
}

export function err(s: string): void {
  const st = store.getStore();
  if (st) st.stderr.push(s);
  else process.stderr.write(s);
}

export function env(): NodeJS.ProcessEnv {
  return store.getStore()?.env ?? process.env;
}

export function home(): string {
  return orchHome(env());
}

export async function captured(
  callerEnv: Record<string, string | undefined>,
  fn: () => Promise<number> | number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const st: IoStore = { env: { ...process.env, ...callerEnv }, stdout: [], stderr: [] };
  const code = await store.run(st, async () => await fn());
  return { code, stdout: st.stdout.join(""), stderr: st.stderr.join("") };
}

// Runs fn with stderr dropped (`2>/dev/null`); stdout still reaches the caller's stream.
export async function quietStderr<T>(fn: () => Promise<T>): Promise<T> {
  const parent = store.getStore();
  const st: IoStore = { env: parent?.env ?? process.env, stdout: [], stderr: [] };
  const r = await store.run(st, fn);
  if (st.stdout.length) out(st.stdout.join(""));
  return r;
}
