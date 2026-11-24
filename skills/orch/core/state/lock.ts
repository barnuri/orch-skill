// Single-flight locks, same files and rules as lib/core/locks.sh.
// <home>/locks/<name>.pid holds the owner pid. A lock whose pid is dead or empty is free.
// Release truncates the file (nothing is deleted). Takeover of an empty or dead lock runs under a
// mkdir mutex <name>.pid.take; a mutex older than 5 s is ignored.
import { mkdir, rmdir, stat } from "node:fs/promises";
import { openSync, writeSync, closeSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./home.ts";

export function lockFile(home: string, name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(paths.locks(home), `${safe}.pid`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(f: string): Promise<number | null> {
  const text = await Bun.file(f).text().catch(() => "");
  const n = parseInt(text.trim(), 10);
  return text.trim() === "" || Number.isNaN(n) ? null : n;
}

async function tryCreateExclusive(f: string, content: string): Promise<boolean> {
  if (await Bun.file(f).exists()) return false;
  try {
    const fd = openSync(f, "wx");
    writeSync(fd, content);
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

export class OrchLock {
  constructor(readonly home: string, readonly name: string) {}

  private get file(): string {
    return lockFile(this.home, this.name);
  }

  // Returns true when this process holds the lock, false when a live process holds it.
  async acquire(): Promise<boolean> {
    const f = this.file;
    await mkdir(paths.locks(this.home), { recursive: true }).catch(() => undefined);
    if (await tryCreateExclusive(f, `${process.pid}\n`)) return true;
    const cur = await readPid(f);
    if (cur !== null && cur !== process.pid && alive(cur)) return false;
    const m = `${f}.take`;
    try {
      await mkdir(m);
    } catch {
      const st = await stat(m).catch(() => null);
      if (!st || (Date.now() - st.mtimeMs) / 1000 < 5) return false;
    }
    let got = false;
    try {
      const cur2 = await readPid(f);
      if (cur2 === null || cur2 === process.pid || !alive(cur2)) {
        await Bun.write(f, `${process.pid}\n`);
        got = true;
      }
    } finally {
      await rmdir(m).catch(() => undefined);
    }
    return got;
  }

  async release(): Promise<void> {
    const f = this.file;
    if ((await readPid(f)) === process.pid) await Bun.write(f, "");
  }
}

// Polls for the lock: `tries` attempts, `sleepMs` apart (bash run_lock: 600 x 50 ms; node batch: 150 x 200 ms).
// Returns the held lock, or null when another live process still holds it at the last try.
export async function acquireLock(home: string, name: string, tries: number, sleepMs: number): Promise<OrchLock | null> {
  const lock = new OrchLock(home, name);
  for (let i = 0; i <= tries; i++) {
    if (await lock.acquire()) return lock;
    await Bun.sleep(sleepMs);
  }
  return null;
}

/** The live pid that holds the lock, or null. */
export async function lockHolder(home: string, name: string): Promise<number | null> {
  const pid = await readPid(lockFile(home, name));
  return pid !== null && alive(pid) ? pid : null;
}
