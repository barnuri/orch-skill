#!/usr/bin/env bun
// Registers this checkout with Claude Code and installs the global `orch` CLI.
// Idempotent and non-destructive: re-run after `git pull` to update links and refresh only
// what changed. Never overwrites profiles.json, serve.json, runs/, jobs/ or memory.json.
//
//   ./install.ts                  install or update (default)
//   ./install.ts --cli-only       global `orch` CLI + ./config only; skip Claude plugin
//   ./install.ts --with-service   install/refresh the background service (serve.json unchanged)
//   ./install.ts --scope local    plugin scope (first install only)
//   ./install.ts --restart        restart the dashboard service even when sources are unchanged
//   ./install.ts --no-restart     never restart the dashboard service
//   ./install.ts --bin-name NAME  CLI command name (default: orch; saved in <home>/cli.json)
// Also links the opencode plugin mods/opencode/orch-nodes.js into ~/.config/opencode/plugins.
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync,
  chmodSync, statSync, symlinkSync, writeFileSync, rmSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { HOME, REPO_DIR, run, runInherit, trashPath, which } from "./scripts/lib/util.ts";

const DISPATCH = join(REPO_DIR, "skills/orch/scripts/dispatch.ts");
const SKILL_SOURCE_DIRS = ["src/server", "src/dashboard", "src/shared"].map((d) => join(REPO_DIR, d));
const MARKETPLACE_NAME = "orch-skill";
const PLUGIN_ID = `orch@${MARKETPLACE_NAME}`;
const DEFAULT_BIN_NAME = "orch";
const STATE_DIR = process.env["HARNESS_ORCH_HOME"] || join(HOME, ".harness-orch");
const CLI_CONFIG_FILE = join(STATE_DIR, "cli.json");
const BUN = process.env["ORCH_BUN"] || "bun";

let scope = "user";
let withService = false;
let cliOnly = false;
let forceRestart = false;
let skipRestart = false;
let binDir = process.env["ORCH_BIN_DIR"] || join(HOME, ".local/bin");
let binName = process.env["ORCH_BIN_NAME"] ?? DEFAULT_BIN_NAME;
let binNameExplicit = process.env["ORCH_BIN_NAME"] !== undefined;

const say = (s: string): void => console.log(s);
const fail = (s: string): void => console.error(s);

function usage(to: (s: string) => void): void {
  const src = readFileSync(import.meta.path, "utf8").split("\n");
  to(src.slice(1, src.findIndex((l) => l.startsWith("import"))).filter((l) => l.startsWith("//")).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
}

const validBinName = (n: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) && !n.includes("..");

function parseArgs(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--with-service") withService = true;
    else if (a === "--cli-only") cliOnly = true;
    else if (a === "--restart") forceRestart = true;
    else if (a === "--no-restart") skipRestart = true;
    else if (a === "--bin-name") {
      binName = args[++i] ?? "";
      if (!binName) return (fail("install: --bin-name expects a name"), 2);
      if (!validBinName(binName)) return (fail("install: --bin-name must match [A-Za-z0-9._-] and cannot contain /"), 2);
      binNameExplicit = true;
    } else if (a === "--scope") {
      scope = args[++i] ?? "";
      if (!scope) return (fail("install: --scope expects user|project|local"), 2);
    } else if (a === "-h" || a === "--help" || a === "help") {
      usage(say);
      process.exit(0);
    } else {
      fail(`install: unknown argument ${a}\n`);
      usage(fail);
      return 2;
    }
  }
  return 0;
}

function readCliConfig(): { name?: string; bin_dir?: string } | null {
  try {
    return JSON.parse(readFileSync(CLI_CONFIG_FILE, "utf8"));
  } catch {
    return null;
  }
}

function adoptCliConfig(): number {
  if (!validBinName(binName)) return (fail(`install: invalid ORCH_BIN_NAME ${binName}`), 2);
  const c = readCliConfig();
  if (!c) return 0;
  if (!binNameExplicit && c.name) binName = c.name;
  if (c.bin_dir) binDir = c.bin_dir;
  if (!validBinName(binName)) binName = DEFAULT_BIN_NAME;
  return 0;
}

function saveCliConfig(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${CLI_CONFIG_FILE}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ name: binName, bin_dir: binDir }) + "\n");
  renameSync(tmp, CLI_CONFIG_FILE);
}

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Follows up to 8 symlink hops; returns the resolved path. */
function linkTarget(path: string): string {
  let p = path;
  for (let hops = 0; isLink(p) && hops < 8; hops++) {
    const t = readlinkSync(p);
    p = t.startsWith("/") ? t : join(dirname(p), t);
  }
  return join(resolve(dirname(p)), p.split("/").pop() as string);
}

const WRAPPER = join(REPO_DIR, "skills/orch/scripts/dispatch.ts");

function removePreviousCliSymlink(): void {
  const c = readCliConfig();
  if (!c?.name || c.name === binName || !c.bin_dir) return;
  const old = join(c.bin_dir, c.name);
  if (!isLink(old) || linkTarget(old) !== WRAPPER) return;
  say(`cli: removing previous command ${old}`);
  trashPath(old, STATE_DIR);
}

function removeSupersededCliSymlinks(): void {
  if (!existsSync(binDir)) return;
  for (const name of readdirSync(binDir)) {
    const p = join(binDir, name);
    if (name === binName || !isLink(p) || linkTarget(p) !== WRAPPER) continue;
    say(`cli: removing superseded command ${p}`);
    trashPath(p, STATE_DIR);
  }
}

const claudeAvailable = (): boolean => !!which("claude");
const claudeJson = (...a: string[]): string => run(["claude", ...a]).out;
const marketplaceRegistered = (): boolean => claudeJson("plugin", "marketplace", "list", "--json").includes(`"${MARKETPLACE_NAME}"`);
const marketplacePointsHere = (): boolean => marketplaceRegistered() && claudeJson("plugin", "marketplace", "list", "--json").includes(REPO_DIR);
const pluginInstalled = (): boolean => claudeJson("plugin", "list", "--json").includes(`"${PLUGIN_ID}"`);

async function addMarketplace(): Promise<boolean> {
  if (marketplacePointsHere()) return (say(`marketplace ${MARKETPLACE_NAME}: already points at this checkout`), true);
  if (marketplaceRegistered()) {
    say(`marketplace ${MARKETPLACE_NAME}: updating registration -> ${REPO_DIR}`);
    return (await runInherit(["claude", "plugin", "marketplace", "update", MARKETPLACE_NAME])) === 0;
  }
  say(`marketplace ${MARKETPLACE_NAME}: registering -> ${REPO_DIR}`);
  return (await runInherit(["claude", "plugin", "marketplace", "add", REPO_DIR])) === 0;
}

async function installPlugin(): Promise<boolean> {
  if (pluginInstalled()) return (say(`plugin ${PLUGIN_ID}: already installed (restart Claude Code to load skill changes)`), true);
  say(`plugin ${PLUGIN_ID}: installing (scope: ${scope})`);
  return (await runInherit(["claude", "plugin", "install", PLUGIN_ID, "--scope", scope, "--yes"])) === 0;
}

async function installDashboardDeps(): Promise<void> {
  if (existsSync(join(REPO_DIR, "node_modules/hono"))) return;
  say("deps: installing the dashboard dependencies");
  if ((await runInherit([BUN, "install", "--frozen-lockfile"], { cwd: REPO_DIR })) !== 0) {
    say("deps: bun install failed; the dashboard retries on first use");
  }
}

// The orch-graph mod (live run graph pane) loads through CLAUDE_CODE_PLUGIN_DIRS in the user's
// settings `env`, since a marketplace plugin does not carry function-hook modules. Appends the
// folder once and keeps any other folders listed there. Writes through a symlinked settings file.
function registerGraphMod(): boolean {
  const settings = join(process.env["CLAUDE_CONFIG_DIR"] || join(HOME, ".claude"), "settings.json");
  const modDir = join(REPO_DIR, "mods/orch-graph");
  let json: { env?: Record<string, string> } = {};
  if (existsSync(settings)) {
    try {
      json = JSON.parse(readFileSync(settings, "utf8"));
    } catch {
      return (fail(`install: could not read ${settings}`), false);
    }
  }
  const dirs = (json.env?.["CLAUDE_CODE_PLUGIN_DIRS"] ?? "").split(":").filter(Boolean);
  if (!dirs.includes(modDir)) {
    json.env = { ...(json.env ?? {}), CLAUDE_CODE_PLUGIN_DIRS: [...dirs, modDir].join(":") };
  }
  writeFileSync(settings, JSON.stringify(json, null, 2) + "\n");
  say(`claude: orch-graph mod registered (${modDir})`);
  return true;
}

async function installClaudePlugin(): Promise<number> {
  if (!claudeAvailable()) {
    fail(
      "install: the `claude` CLI is not on PATH.\n  Install Claude Code first: https://docs.claude.com/en/docs/claude-code\n  Or pass --cli-only to install just the global `orch` command and ./config link.",
    );
    return 127;
  }
  if (!(await addMarketplace())) return 1;
  if (!(await installPlugin())) return 1;
  return registerGraphMod() ? 0 : 1;
}

function bootstrapState(): boolean {
  const had = existsSync(join(STATE_DIR, "profiles.json")) && existsSync(join(STATE_DIR, "serve.json"));
  const r = run([BUN, DISPATCH, "init"], { env: { ORCH_INSTALL_QUIET: "1", HARNESS_ORCH_HOME: STATE_DIR } });
  if (r.code !== 0) return (fail(`install: could not bootstrap ${STATE_DIR}`), false);
  say(had ? `state: ${STATE_DIR} ok (existing data left unchanged)` : `state: bootstrapped missing files under ${STATE_DIR}`);
  return true;
}

function linkConfig(): boolean {
  const cfg = process.env["ORCH_CONFIG_LINK"] || join(REPO_DIR, "config"); // tests point it away from the checkout
  if (isLink(cfg) && readlinkSync(cfg) === STATE_DIR) say(`config: ./config -> ${STATE_DIR} (unchanged)`);
  else {
    try {
      rmSync(cfg, { force: true }); // our own symlink only; a real folder makes rmSync throw below
      symlinkSync(STATE_DIR, cfg);
    } catch {
      return (fail(`install: could not link ${cfg} -> ${STATE_DIR}`), false);
    }
    say(`config: linked ./config -> ${STATE_DIR}`);
  }
  return bootstrapState();
}

function installCli(): boolean {
  const cliBin = join(binDir, binName);
  if (!existsSync(WRAPPER)) return (fail(`install: ${WRAPPER} missing — broken checkout?`), false);
  chmodSync(WRAPPER, 0o755);
  mkdirSync(binDir, { recursive: true });
  removePreviousCliSymlink();
  removeSupersededCliSymlinks();
  if (existsSync(cliBin) && !isLink(cliBin)) {
    return (fail(`install: ${cliBin} exists and is not a symlink — move it aside and re-run`), false);
  }
  if (isLink(cliBin)) {
    if (linkTarget(cliBin) === WRAPPER) {
      say(`cli: ${cliBin} already points at this checkout`);
      saveCliConfig();
      return true;
    }
    say(`cli: updating ${cliBin} (was ${readlinkSync(cliBin)})`);
  } else say(`cli: installing ${cliBin}`);
  rmSync(cliBin, { force: true });
  symlinkSync(WRAPPER, cliBin);
  saveCliConfig();
  say(`cli: ${cliBin} -> ${WRAPPER}`);
  return true;
}

function ensureLocalBinPath(): void {
  let updated = false;
  for (const name of [".zshrc", ".zprofile", ".bash_profile", ".bashrc"]) {
    const rc = join(HOME, name);
    if (!existsSync(rc) || readFileSync(rc, "utf8").includes("# orch-skill: global CLI")) continue;
    appendFileSync(rc, `\n# orch-skill: global CLI\nexport PATH="${binDir}:$PATH"\n`);
    updated = true;
    say(`path: added ${binDir} to ${rc}`);
  }
  if (!updated && !existsSync(join(HOME, ".zshrc")) && !existsSync(join(HOME, ".zprofile"))) {
    writeFileSync(join(HOME, ".zshrc"), `# orch-skill: global CLI\nexport PATH="${binDir}:$PATH"\n`);
    say(`path: created ~/.zshrc with ${binDir}`);
  } else if (!updated) say(`path: ${binDir} already configured`);
}

const serviceUnitPath = (): string =>
  process.platform === "darwin"
    ? join(HOME, "Library/LaunchAgents/io.github.barnuri.orch.plist")
    : process.platform === "linux"
      ? join(process.env["XDG_CONFIG_HOME"] || join(HOME, ".config"), "systemd/user/orch-dashboard.service")
      : "";
const serviceInstalled = (): boolean => !!serviceUnitPath() && existsSync(serviceUnitPath());

function serviceUnitMatchesCheckout(): boolean {
  const u = serviceUnitPath();
  if (!u || !existsSync(u)) return false;
  const t = readFileSync(u, "utf8");
  return t.includes(DISPATCH) && t.includes(STATE_DIR);
}

function newestMtime(dir: string): number {
  let best = 0;
  if (!existsSync(dir)) return 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    best = Math.max(best, st.isDirectory() ? newestMtime(p) : st.mtimeMs);
  }
  return best;
}

function skillSourcesChanged(): boolean {
  const pidFile = join(STATE_DIR, "serve/pid");
  if (!existsSync(pidFile) || statSync(pidFile).size === 0) return false;
  const at = statSync(pidFile).mtimeMs;
  return SKILL_SOURCE_DIRS.some((d) => newestMtime(d) > at);
}

const serviceCmd = (sub: string): Promise<number> => runInherit([BUN, join(REPO_DIR, "scripts/service.ts"), sub]);

async function refreshService(): Promise<number> {
  if (!serviceInstalled()) return 0;
  if (skipRestart) return (say("service: left running (--no-restart)"), 0);
  const head = (): void => say("\n--- dashboard service ---");
  if (withService) return (head(), await serviceCmd("install"));
  if (!serviceUnitMatchesCheckout()) {
    head();
    say("service: supervisor unit is stale — refreshing");
    return await serviceCmd("install");
  }
  if (forceRestart) return (head(), say("service: restarting (--restart)"), await serviceCmd("restart"));
  if (skillSourcesChanged()) return (head(), say("service: skill sources changed — restarting"), await serviceCmd("restart"));
  say("service: unchanged (running skill matches this checkout)");
  return 0;
}

function printSummary(): void {
  const svc = `bun ${REPO_DIR}/scripts/service.ts`;
  const lines = [
    "",
    `Done. ${cliOnly ? "CLI + config ready." : "Ready."}`,
    "",
    `  • Global CLI: ${binDir}/${binName}`,
    `  • State dir:  ${STATE_DIR}  (./config — your data is never overwritten by install)`,
    `  • Config:     ${binName} serve config show`,
  ];
  if (!cliOnly && claudeAvailable()) lines.push("  • Claude:     restart Claude Code after skill changes");
  else if (!cliOnly) lines.push("  • Claude:     skipped (claude not on PATH) — re-run without --cli-only to add the plugin");
  lines.push(`  • Dashboard:  ${binName} ui`);
  if (serviceInstalled()) lines.push(`  • Service:    ${svc} status`);
  else if (!withService) lines.push(`  • Service:    ${svc} install   # optional always-on dashboard`);
  say(lines.join("\n"));
  say("\nRe-run ./install.ts after git pull; use --restart to bounce the service anyway.");
}

function checkBun(): boolean {
  const bin = which(BUN);
  if (!bin) {
    fail("orch requires bun (https://bun.sh)");
    return false;
  }
  const ver = run([bin, "--version"]).out.trim();
  const [major, minor] = ver.split(".").map(Number);
  if (major === undefined || minor === undefined || Number.isNaN(major) || Number.isNaN(minor)) {
    return (fail(`install: could not read bun version from ${bin}`), false);
  }
  if (major < 1 || (major === 1 && minor < 2)) {
    return (fail(`install: bun ${ver} is older than 1.2. Upgrade with:\n  bun upgrade`), false);
  }
  return true;
}

async function main(): Promise<number> {
  let rc = parseArgs(process.argv.slice(2));
  if (rc) return rc;
  rc = adoptCliConfig();
  if (rc) return rc;
  if (!checkBun()) return 1;
  say(`orch-skill install/update (${REPO_DIR})\n`);
  if (!linkConfig()) return 1;
  if (!installCli()) return 1;
  ensureLocalBinPath();
  await installDashboardDeps();
  if ((await runInherit([BUN, join(REPO_DIR, "scripts/install-opencode-plugin.ts")])) !== 0) {
    say("install: opencode plugin not linked (see above)");
  }
  if (!cliOnly) {
    rc = await installClaudePlugin();
    if (rc) return rc === 127 ? 127 : 1;
  } else say("claude: skipped (--cli-only)");
  if (await refreshService()) return 1;
  printSummary();
  return 0;
}

process.exit(await main());
