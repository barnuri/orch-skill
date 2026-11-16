// Recoverable removal. Never unlinks: `trash` when on PATH, else a rename into <home>/.trash/<stamp>/.
import { basename, join } from "node:path";
import { mkdir, rename, stat } from "node:fs/promises";
import { paths } from "./home.ts";

export function stamp(d: Date = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export async function trashPath(home: string, target: string): Promise<boolean> {
  const t = target.replace(/\/+$/, "");
  if (!(await stat(t).catch(() => null))) return true;
  // ORCH_TRASH_MOVE=1 (test env): skip the `trash` program, which takes about a second per call; the move below is the same recoverable removal.
  if (process.env.ORCH_TRASH_MOVE !== "1" && Bun.which("trash", { PATH: process.env.PATH ?? "" })) {
    const p = Bun.spawn(["trash", t], { stdout: "ignore", stderr: "ignore" });
    if ((await p.exited) === 0) return true;
  }
  const dest = join(paths.trash(home), stamp());
  await mkdir(dest, { recursive: true });
  let to = join(dest, basename(t));
  for (let i = 1; await stat(to).catch(() => null); i++) to = join(dest, `${basename(t)}.${i}`);
  await rename(t, to);
  return true;
}
