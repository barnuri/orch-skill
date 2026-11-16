#!/usr/bin/env bun
// Links the orch opencode plugin (mods/opencode/orch-nodes.js) into opencode's global plugin folder.
// Idempotent. A real file already there is copied to <name>.orch-backup-<epoch> and replaced by the link.
// Skips when opencode is not installed (no config folder and no `opencode` on PATH).
//   OPENCODE_PLUGIN_DIR  target folder (default: ${XDG_CONFIG_HOME:-~/.config}/opencode/plugins)
import { copyFileSync, existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { HOME, REPO_DIR, which } from "./lib/util.ts";

const SOURCE = join(REPO_DIR, "mods/opencode/orch-nodes.js");
const configDir = join(process.env["XDG_CONFIG_HOME"] || join(HOME, ".config"), "opencode");
const explicit = process.env["OPENCODE_PLUGIN_DIR"];
const pluginDir = explicit || join(configDir, "plugins");
const target = join(pluginDir, "orch-nodes.js");

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

if (!existsSync(SOURCE)) {
  console.error(`opencode: plugin source missing: ${SOURCE}`);
  process.exit(1);
}
if (!explicit && !existsSync(configDir) && !which("opencode")) {
  console.log("opencode: plugin skipped (opencode not installed)");
  process.exit(0);
}
if (isLink(target) && readlinkSync(target) === SOURCE) {
  console.log(`opencode: orch-nodes plugin -> ${SOURCE} (unchanged)`);
  process.exit(0);
}
mkdirSync(pluginDir, { recursive: true });
if (existsSync(target) && !isLink(target)) {
  const backup = `${target}.orch-backup-${Math.floor(Date.now() / 1000)}`;
  copyFileSync(target, backup);
  console.log(`opencode: backed up the old plugin to ${backup}`);
}
try {
  rmSync(target, { force: true }); // replaces our own link or the backed-up copy
  symlinkSync(SOURCE, target);
} catch {
  console.error(`opencode: could not link ${target}`);
  process.exit(1);
}
console.log(`opencode: linked orch-nodes plugin ${target} -> ${SOURCE} (loads on the next opencode start)`);
