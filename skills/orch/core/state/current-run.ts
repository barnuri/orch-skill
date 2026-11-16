// The saved current run (`dispatch.ts use <run-id>` writes <home>/current-run). "." resolves to it.
import { readFile, writeFile } from "node:fs/promises";
import { paths } from "./home.ts";

export async function currentRunResolve(home: string, arg: string): Promise<string> {
  if (arg !== ".") return arg;
  const id = (await readFile(paths.currentRun(home), "utf8").catch(() => "")).split("\n")[0]!.trim();
  if (!id) throw new Error('run id ".": no current run; set one with: dispatch.ts use <run-id>');
  return id;
}

export async function currentRunSet(home: string, runId: string): Promise<void> {
  await writeFile(paths.currentRun(home), runId + "\n");
}
