#!/usr/bin/env bun
// Reverses ./install.ts: uninstalls the `orch` plugin and drops the marketplace registration.
// Leaves this checkout and ~/.harness-orch alone — pass --purge-state to also remove the state
// directory (recoverably, via `trash`).
//
//   ./uninstall.ts                 remove the plugin + marketplace
//   ./uninstall.ts --with-service  also remove the background dashboard service
//   ./uninstall.ts --purge-state   also remove ~/.harness-orch (runs, jobs, profiles, memory)
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME, REPO_DIR, run, runInherit, trashPath, which } from "./scripts/lib/util.ts";

const MARKETPLACE_NAME = "orch-skill";
const PLUGIN_ID = `orch@${MARKETPLACE_NAME}`;
const ORCH_HOME = process.env["HARNESS_ORCH_HOME"] || join(HOME, ".harness-orch");
const binDir = process.env["ORCH_BIN_DIR"] || join(HOME, ".local/bin");
const binNameEnv = process.env["ORCH_BIN_NAME"] || "orch";

let withService = false;
let purge = false;
for (const a of process.argv.slice(2)) {
  if (a === "--with-service") withService = true;
  else if (a === "--purge-state") purge = true;
  else if (a === "-h" || a === "--help") {
    const src = readFileSync(import.meta.path, "utf8").split("\n");
    console.log(src.slice(1, 8).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
    process.exit(0);
  } else {
    console.error(`uninstall: unknown argument ${a}\n`);
    process.exit(2);
  }
}

function installedCliBin(): string {
  let name = binNameEnv;
  let dir = binDir;
  try {
    const c = JSON.parse(readFileSync(join(ORCH_HOME, "cli.json"), "utf8"));
    name = c.name ?? "orch";
    dir = c.bin_dir ?? dir;
  } catch {}
  return join(dir, name);
}

function unregisterGraphMod(): boolean {
  const settings = join(process.env["CLAUDE_CONFIG_DIR"] || join(HOME, ".claude"), "settings.json");
  const modDir = join(REPO_DIR, "mods/orch-graph");
  if (!existsSync(settings)) return true;
  let json: { env?: Record<string, string> };
  try {
    json = JSON.parse(readFileSync(settings, "utf8"));
  } catch {
    return (console.error(`uninstall: could not read ${settings}`), false);
  }
  const cur = json.env?.["CLAUDE_CODE_PLUGIN_DIRS"];
  if (cur !== undefined && json.env) {
    const dirs = cur.split(":").filter((d) => d !== "" && d !== modDir);
    if (dirs.length === 0) delete json.env["CLAUDE_CODE_PLUGIN_DIRS"];
    else json.env["CLAUDE_CODE_PLUGIN_DIRS"] = dirs.join(":");
  }
  writeFileSync(settings, JSON.stringify(json, null, 2) + "\n");
  console.log("claude: orch-graph mod unregistered");
  return true;
}

async function main(): Promise<number> {
  if (withService) await runInherit([process.execPath, join(REPO_DIR, "scripts/service.ts"), "uninstall"]);
  const cli = installedCliBin();
  if (existsSync(cli) || lstatSync(cli, { throwIfNoEntry: false })) {
    console.log(`removing ${cli}`);
    trashPath(cli, ORCH_HOME);
  }
  if (!which("claude")) return (console.error("uninstall: the `claude` CLI is not on PATH — nothing to unregister"), 127);
  const q = (...a: string[]): string => run(["claude", ...a]).out;
  if (!q("plugin", "list", "--json").includes(`"${PLUGIN_ID}"`)) console.log(`plugin ${PLUGIN_ID} is not installed`);
  else {
    console.log(`uninstalling ${PLUGIN_ID}`);
    if ((await runInherit(["claude", "plugin", "uninstall", PLUGIN_ID])) !== 0) return 1;
  }
  if (!unregisterGraphMod()) return 1;
  if (!q("plugin", "marketplace", "list", "--json").includes(`"${MARKETPLACE_NAME}"`)) console.log(`marketplace ${MARKETPLACE_NAME} is not registered`);
  else {
    console.log(`removing marketplace ${MARKETPLACE_NAME}`);
    if ((await runInherit(["claude", "plugin", "marketplace", "remove", MARKETPLACE_NAME])) !== 0) return 1;
  }
  if (purge) {
    console.log(`removing state directory ${ORCH_HOME}`);
    trashPath(ORCH_HOME, join(HOME, ".harness-orch-trash"));
  }
  console.log("\nDone. Restart Claude Code to drop the skill from the session.");
  return 0;
}

process.exit(await main());
