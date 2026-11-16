// orch CLI entry: argv parse, command table, exit codes. Bun built-ins only, no npm imports.
// Importing this module has no side effects; main() runs only when executed directly.

import { cmdNodeTell, cmdNodeAsk, cmdNodeInbox } from "./commands/inbox.ts";
import { nodeAdd, nodeUpdate, nodeReport } from "./commands/node.ts";
import { nodeBatch } from "./commands/node-batch.ts";
import { runStatusCommand } from "./commands/run.ts";
import { nodeSelections } from "./commands/selections.ts";
import { profileList, profileShow, profilePickCommand, modelList } from "./commands/profile.ts";
import { herdrCommand, HERDR_VERBS } from "./adapters/herdr.ts";
import { doctor } from "./commands/doctor.ts";
import { delegatePlan, delegateTask, delegateFinding, delegateShow, DELEGATE_USAGE } from "./commands/delegate.ts";

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
  ...Object.fromEntries(HERDR_VERBS.map((v): [string, Handler] => [`herdr ${v}`, (a) => herdrCommand(v, a)])),
  // `delegate <run> <verb>`: the run id is the second word, so the key is built in main().
  "delegate plan": (a) => delegatePlan(a),
  "delegate task": (a) => delegateTask(a),
  "delegate finding": (a) => delegateFinding(a),
  "delegate show": (a) => delegateShow(a),
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
  // `delegate <run> <verb> ...`: the verb is the third word. The handler gets the run id first, then
  // the rest, so the verb is dropped from argv.
  if (words[0] === "delegate") {
    const dkey = `delegate ${words[2] ?? ""}`.trim();
    const dh = COMMANDS[dkey];
    if (!dh || words.length < 3) {
      process.stderr.write(`usage: ${DELEGATE_USAGE}\n`);
      return 2;
    }
    const drest: string[] = [];
    let nonflag = 0;
    for (const a of argv) {
      if (a.startsWith("--")) {
        drest.push(a);
        continue;
      }
      nonflag++;
      if (nonflag === 1 || nonflag === 3) continue;
      drest.push(a);
    }
    return await dh(drest);
  }
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
