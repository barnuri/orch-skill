// Atomic JSON state: write <file>.tmp.<pid>, then rename over the target. Never unlinks.
import { appendFile, rename } from "node:fs/promises";
import { paths } from "./home.ts";

export async function readJson<T = unknown>(file: string): Promise<T> {
  return (await Bun.file(file).json()) as T;
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp.${process.pid}`;
  await Bun.write(tmp, JSON.stringify(value, null, 2) + "\n");
  await rename(tmp, file);
}

// A run's state.json, or null when the run does not exist.
export type RunState = Record<string, any> & { nodes: Array<Record<string, any>> };

export async function loadRun(home: string, runId: string): Promise<RunState | null> {
  const f = paths.runState(home, runId);
  if (!(await Bun.file(f).exists())) return null;
  return readJson<RunState>(f);
}

export async function saveRun(home: string, runId: string, run: RunState): Promise<void> {
  await writeJsonAtomic(paths.runState(home, runId), run);
}

// One JSON line per event, appended to the run's events.jsonl. Never throws (run_event semantics).
export async function appendEvents(home: string, runId: string, lines: unknown[]): Promise<void> {
  if (lines.length === 0) return;
  const text = lines.map((e) => JSON.stringify(e) + "\n").join("");
  await appendFile(paths.runEvents(home, runId), text).catch(() => undefined);
}
