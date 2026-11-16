// orch CLI entry: argv parse, command table, exit codes. Bun built-ins only, no npm imports.
// Importing this module has no side effects; main() runs only when executed directly.

import { cmdNodeTell, cmdNodeAsk, cmdNodeInbox } from "./commands/inbox.ts";
import { nodeAdd, nodeUpdate, nodeReport } from "./commands/node.ts";
import { nodeBatch } from "./commands/node-batch.ts";
import { runStatusCommand } from "./commands/run.ts";
import { nodeSelections } from "./commands/selections.ts";
import { profileList, profileShow, profilePickCommand, modelList } from "./commands/profile.ts";
import { doctor } from "./commands/doctor.ts";
import { serveCommand, serveStatus, serveConfig, serveRecover, uiCommand, artifactCommand } from "./commands/serve.ts";
import { suggestCommand, syncCommand } from "./commands/suggest.ts";
import { demoCommand } from "./commands/demo.ts";
import { orchHome } from "./state/home.ts";
import { viaServer } from "./client.ts";
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
  // `delegate <run> <verb>`: the run id is the second word, so the key is built in main().
  "delegate plan": (a) => delegatePlan(a),
  "delegate task": (a) => delegateTask(a),
  "delegate finding": (a) => delegateFinding(a),
  "delegate show": (a) => delegateShow(a),
  // One-word commands: the verb is the first handler argument (or a flag).
  serve: serveCommand,
  "serve status": serveStatus,
  "serve config": serveConfig,
  "serve recover": serveRecover,
  ui: uiCommand,
  artifact: artifactCommand,
  suggest: suggestCommand,
  demo: demoCommand,
  sync: syncCommand,
};

const ONE_WORD = new Set(["serve", "ui", "artifact", "suggest", "demo", "sync"]);
// Commands the dashboard server answers on its socket (same core function, in its process).
const SOCKET_KEYS = new Set(["suggest", "serve status", "serve config"]);

function resolveCommand(words: string[]): { key: string; skip: number } | null {
  const two = `${words[0]} ${words[1] ?? ""}`.trim();
  if (COMMANDS[two]) return { key: two, skip: 2 };
  if (ONE_WORD.has(words[0]) && COMMANDS[words[0]]) return { key: words[0], skip: 1 };
  return null;
}

export function isSocketable(argv: string[]): boolean {
  const { words } = parseArgv(argv);
  const r = words.length ? resolveCommand(words) : null;
  return !!r && SOCKET_KEYS.has(r.key);
}

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

export async function main(argv: string[], opts: { direct?: boolean } = {}): Promise<number> {
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
  const resolved = resolveCommand(words);
  if (!resolved) {
    const key = `${words[0]} ${words[1] ?? ""}`.trim();
    process.stderr.write(`orch: unknown command '${key}'\n${usage()}\n`);
    return 2;
  }
  const handler = COMMANDS[resolved.key];
  if (!opts.direct && process.env.ORCH_DIRECT !== "1" && SOCKET_KEYS.has(resolved.key)) {
    const r = await viaServer(orchHome(), argv);
    if (r) {
      process.stdout.write(r.stdout);
      process.stderr.write(r.stderr);
      return r.code;
    }
  }
  // Handlers get every argument after the command words, flags included.
  const rest: string[] = [];
  let skipped = 0;
  for (const a of argv) {
    if (!a.startsWith("--") && skipped < resolved.skip) skipped++;
    else rest.push(a);
  }
  return await handler(rest);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
