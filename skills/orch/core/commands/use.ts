// `use [<run-id>]`: save or print the current run. Port of cmd_use (lib/runs/current-run.sh).
import { existsSync, mkdirSync } from "node:fs";
import { orchHome, paths } from "../state/home.ts";
import { currentRunSet } from "../state/current-run.ts";
import { coordinatorAutoRecord } from "./inbox.ts";

export async function useCommand(args: string[]): Promise<number> {
  const home = orchHome();
  const runId = args[0] ?? "";
  if (!runId) {
    const text = (await Bun.file(paths.currentRun(home)).text().catch(() => "")).trim();
    if (!text) { process.stderr.write("no current run; set one with: dispatch.ts use <run-id>\n"); return 1; }
    process.stdout.write((await Bun.file(paths.currentRun(home)).text()));
    return 0;
  }
  if (runId.includes("/") || runId === "." || runId === "..") { process.stderr.write(`use: invalid run id: ${runId}\n`); return 2; }
  if (!existsSync(paths.runState(home, runId))) { process.stderr.write(`use: no such run: ${runId}\n`); return 1; }
  mkdirSync(home, { recursive: true });
  await currentRunSet(home, runId);
  await coordinatorAutoRecord(home, runId).catch(() => undefined);
  process.stdout.write(`${runId}\n`);
  return 0;
}
