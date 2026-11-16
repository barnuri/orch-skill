import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export const REPO_DIR: string = resolve(import.meta.dir, "../..");
export const DISPATCH: string = process.env["ORCH_DISPATCH"] || join(REPO_DIR, "skills/orch/scripts/dispatch.ts");
export const HOME: string = homedir();

export function which(name: string): string | null {
  if (name.includes("/")) return existsSync(name) ? name : null;
  return Bun.which(name);
}

export interface RunResult {
  code: number;
  out: string;
  err: string;
}

export function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): RunResult {
  try {
    const p = Bun.spawnSync(cmd, {
      cwd: opts.cwd,
      env: opts.env ? ({ ...process.env, ...opts.env } as Record<string, string>) : process.env,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    return { code: p.exitCode ?? 1, out: p.stdout.toString(), err: p.stderr.toString() };
  } catch {
    return { code: 127, out: "", err: `${cmd[0]}: not found` };
  }
}

/** Runs a command with inherited stdio and returns its exit code. */
export async function runInherit(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<number> {
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? ({ ...process.env, ...opts.env } as Record<string, string>) : process.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  return await p.exited;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Never rm: `trash` when available, otherwise a move under <fallbackDir>/.trash/<stamp>/. */
export function trashPath(target: string, fallbackDir: string): boolean {
  if (!existsSync(target)) return true;
  if (which("trash") && run(["trash", target]).code === 0) return true;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  const yard = join(fallbackDir, ".trash", stamp);
  mkdirSync(yard, { recursive: true });
  renameSync(target, join(yard, target.split("/").pop() as string));
  return true;
}

export function ensureDir(p: string): void {
  mkdirSync(dirname(p), { recursive: true });
}

export function tmpDir(): string {
  return (process.env["TMPDIR"] ?? "/tmp").replace(/\/+$/, "") || "/tmp";
}
