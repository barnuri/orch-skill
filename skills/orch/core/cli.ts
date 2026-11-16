// orch CLI entry: argv parse, command table, exit codes. Bun built-ins only, no npm imports.
// Importing this module has no side effects; main() runs only when executed directly.

import { cmdNodeTell, cmdNodeAsk, cmdNodeInbox } from "./commands/inbox.ts";
import { nodeAdd, nodeUpdate, nodeReport } from "./commands/node.ts";
import { nodeBatch } from "./commands/node-batch.ts";
import { runStatusCommand } from "./commands/run.ts";
import { nodeSelections } from "./commands/selections.ts";
import { profileList, profileShow, profilePickCommand, modelList } from "./commands/profile.ts";
import { doctor } from "./commands/doctor.ts";

export const VERSION = "0.1.0";

export type Handler = (args: string[]) => Promise<number> | number;

// Ported `<group> <verb>` commands. Keep in step with PORTED_COMMANDS in scripts/dispatch.sh.
export const COMMANDS: Record<string, Handler> = {
  "node tell": cmdNodeTell,
  "node ask": cmdNodeAsk,
  "node inbox": cmdNodeInbox,
  "node add": nodeAdd,
  "node update": nodeUpdate,
  "node report": nodeReport,
  "node batch": nodeBatch,
  "run status": runStatusCommand,
  "node selections": nodeSelections,
  "profile list": profileList,
  "profile show": profileShow,
  "profile pick": profilePickCommand,
  "model list": modelList,
};

export function parseArgv(argv: string[]): { flags: Set<string>; words: string[] } {
  const flags = new Set<string>();
  const words: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a);
    else words.push(a);
  }
  return { flags, words };
}

function usage(): string {
  return [
    "usage: orch --version | orch <group> <verb> [args...]",
    "ported commands: " + (Object.keys(COMMANDS).join(", ") || "(none)"),
  ].join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const { flags, words } = parseArgv(argv);
  if (flags.has("--version")) {
    process.stdout.write(`orch ${VERSION}\n`);
    return 0;
  }
  if (words.length === 0 || flags.has("--help") || flags.has("-h")) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  if (words[0] === "doctor" && words.length === 1) return doctor();
  const key = `${words[0]} ${words[1] ?? ""}`.trim();
  const handler = COMMANDS[key];
  if (!handler) {
    process.stderr.write(`orch: unknown command '${key}'\n${usage()}\n`);
    return 2;
  }
  // Handlers get every argument after the two command words, flags included.
  const rest: string[] = [];
  let skipped = 0;
  for (const a of argv) {
    if (!a.startsWith("--") && skipped < 2) skipped++;
    else rest.push(a);
  }
  return await handler(rest);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
