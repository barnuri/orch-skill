#!/usr/bin/env bun
// Optional: run the orch dashboard server as an always-on background service, so the UI is up
// whenever you want it without starting anything by hand. Entirely opt-in: `orch ui` works fine
// without it, starting the same server on demand.
//
//   service.ts install [--host H] [--port P] [--home DIR] [--require-token] [--allow-remote]
//                                                           register + start (macOS launchd / Linux systemd --user)
//   service.ts uninstall                                    stop + deregister
//   service.ts restart                                      stop + start (run this after changing the skill)
//   service.ts status                                       supervisor state, listener probe, dashboard URL
//   service.ts logs [-n N]                                  tail the service log
//
// The service runs `bun dispatch.ts serve`, which reads bind address, port and auth policy from
// <home>/serve.json, the same file `orch serve`, `orch ui` and `orch serve config` use.
// Install flags update that file; edit it directly and `service.ts restart` to apply.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname as osHostname } from "node:os";
import { readTlsConfig } from "../src/server/tls/config.ts";
import { formatHttpsLine, readTlsStatus } from "../src/server/tls/status-file.ts";
import { DISPATCH, HOME, REPO_DIR, run, sleep, trashPath, which } from "./lib/util.ts";

const SKILL_DIR = join(REPO_DIR, "skills/orch");
// ORCH_SERVICE_LABEL / ORCH_SERVICE_UNIT name a second, throwaway service (tests, sandbox checks); the defaults are the real one.
const SERVICE_LABEL = process.env["ORCH_SERVICE_LABEL"] || "io.github.barnuri.orch";
const SYSTEMD_UNIT_NAME = process.env["ORCH_SERVICE_UNIT"] || "orch-dashboard.service";
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = "6724";
const THROTTLE_SECS = 10;
const SELF = `bun ${import.meta.path}`;

let orchHome = process.env["HARNESS_ORCH_HOME"] || join(HOME, ".harness-orch");
let host = DEFAULT_HOST;
let port = DEFAULT_PORT;
let requireToken = false;
let allowRemote = false;
let configSetArgs: string[] = [];

const out = (s: string): void => void process.stdout.write(s);
const err = (s: string): void => void process.stderr.write(s);

function usage(to: (s: string) => void): void {
  const src = readFileSync(import.meta.path, "utf8").split("\n");
  to(src.slice(1, src.findIndex((l) => l.startsWith("import "))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n") + "\n");
}

function platform(): "launchd" | "systemd" | null {
  if (process.platform === "darwin") return "launchd";
  if (process.platform === "linux") {
    if (!which("systemctl")) {
      err("service: systemctl not found — this script supports macOS launchd and Linux systemd --user\n");
      return null;
    }
    return "systemd";
  }
  err(`service: unsupported platform ${process.platform} — run \`bun ${DISPATCH} serve\` under your own supervisor instead\n`);
  return null;
}

const isUint = (s: string | undefined): s is string => !!s && /^[0-9]+$/.test(s);

function parseInstallOpts(args: string[]): number {
  configSetArgs = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--host") {
      host = args[++i] ?? "";
      if (!host) return (err("service: --host expects a host\n"), 2);
      configSetArgs.push("--host", host);
    } else if (a === "--port") {
      port = args[++i] ?? "";
      if (!isUint(port) || Number(port) > 65535) return (err("service: --port expects 0-65535\n"), 2);
      configSetArgs.push("--port", port);
    } else if (a === "--home") {
      orchHome = args[++i] ?? "";
      if (!orchHome) return (err("service: --home expects a directory\n"), 2);
    } else if (a === "--require-token") {
      requireToken = true;
      configSetArgs.push("--require-token");
    } else if (a === "--allow-remote") {
      allowRemote = true;
      configSetArgs.push("--allow-remote");
    } else {
      err(`service: unknown argument ${a}\n\n`);
      usage(err);
      return 2;
    }
  }
  return 0;
}

function bunPath(): string | null {
  const want = process.env["ORCH_BUN"];
  const resolved = want ? which(want) ?? want : which("bun") ?? process.execPath;
  if (!resolved || !existsSync(resolved)) {
    err("service: bun not found — install Bun 1.3+ (https://bun.sh) or set ORCH_BUN to its path\n");
    return null;
  }
  return resolved;
}

const logFile = (): string => join(orchHome, "serve/service.log");

function preflight(): number {
  if (!existsSync(DISPATCH)) return (err(`service: ${DISPATCH} missing — run this from the repo checkout\n`), 1);
  if (!bunPath()) return 127;
  try {
    mkdirSync(join(orchHome, "serve"), { recursive: true, mode: 0o700 });
  } catch {
    err(`service: cannot create ${join(orchHome, "serve")}\n`);
    return 1;
  }
  return 0;
}

function dispatch(args: string[], env: Record<string, string> = {}): { code: number; out: string } {
  const r = run([bunPath() ?? "bun", DISPATCH, ...args], { env: { HARNESS_ORCH_HOME: orchHome, ...env } });
  return { code: r.code, out: r.out };
}

const configGet = (k: string): string => dispatch(["serve", "config", "get", k]).out.trim();

function persistServeConfig(): boolean {
  if (configSetArgs.length === 0) return dispatch(["init"], { ORCH_INSTALL_QUIET: "1" }).code === 0;
  return dispatch(["serve", "config", "set", ...configSetArgs]).code === 0;
}

const unitPath = (): string =>
  process.platform === "darwin"
    ? join(HOME, "Library/LaunchAgents", `${SERVICE_LABEL}.plist`)
    : join(process.env["XDG_CONFIG_HOME"] || join(HOME, ".config"), "systemd/user", SYSTEMD_UNIT_NAME);

function unitInstalledForCheckout(): boolean {
  const p = unitPath();
  if (!existsSync(p)) return false;
  const t = readFileSync(p, "utf8");
  if (!t.includes(DISPATCH) || !t.includes(orchHome)) return false;
  // A unit written before restarts spared job processes is out of date and gets rewritten.
  if (!/AbandonProcessGroup|KillMode=process/.test(t)) return false;
  // So is one whose PATH lacks ~/.opencode/bin, where the opencode installer puts the binary.
  return t.includes(".opencode/bin");
}

/** Reads the host, port and auth policy the unit's serve.json holds (adopt_installed_settings). */
function loadServeConfig(): void {
  if (!existsSync(join(orchHome, "serve.json"))) dispatch(["init"], { ORCH_INSTALL_QUIET: "1" });
  host = configGet("host") || DEFAULT_HOST;
  port = configGet("port") || DEFAULT_PORT;
  requireToken = ["true", "1"].includes(configGet("require_token"));
  allowRemote = ["true", "1"].includes(configGet("allow_remote"));
}

function dashboardUrl(): string {
  if (!requireToken) return `http://127.0.0.1:${port}/`;
  let token = "";
  try {
    token = readFileSync(join(orchHome, "serve.token"), "utf8").trim();
  } catch {}
  if (!token) return `http://127.0.0.1:${port}/  (token not minted yet — it appears on first start)`;
  return `http://127.0.0.1:${port}/?token=${token}`;
}

async function listening(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return r.status >= 100;
  } catch {
    return false;
  }
}

const removeFile = (t: string): boolean => trashPath(t, orchHome);

const pathValue = (bun: string, extra: string): string =>
  `${HOME}/.local/bin:${HOME}/.opencode/bin:${HOME}/.cargo/bin:${HOME}/bin:${dirname(bun)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin${extra}`;

// ---- launchd (macOS) ----

const launchdPlist = (): string => unitPath();
const uid = (): string => run(["id", "-u"]).out.trim();
const launchdIsLoaded = (): boolean => run(["launchctl", "print", `gui/${uid()}/${SERVICE_LABEL}`]).code === 0;

function launchdWritePlist(): string | null {
  const bun = bunPath();
  if (!bun) return null;
  const plist = launchdPlist();
  mkdirSync(dirname(plist), { recursive: true });
  const log = logFile();
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${bun}</string>
        <string>${DISPATCH}</string>
        <string>serve</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${pathValue(bun, ":/usr/sbin:/sbin")}</string>
        <key>HARNESS_ORCH_HOME</key>
        <string>${orchHome}</string>
        <key>ORCH_BUN</key>
        <string>${bun}</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>${SKILL_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>AbandonProcessGroup</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>${THROTTLE_SECS}</integer>
    <key>StandardOutPath</key>
    <string>${log}</string>
    <key>StandardErrorPath</key>
    <string>${log}</string>
</dict>
</plist>
`,
  );
  return plist;
}

// `launchctl load` exits 0 even when it fails, so success is only ever "the label is loaded now".
// bootstrap can also race a bootout still tearing the unit down, hence the retries.
async function launchdLoad(plist: string): Promise<boolean> {
  for (let i = 0; i < 5; i++) {
    run(["launchctl", "bootstrap", `gui/${uid()}`, plist]);
    if (launchdIsLoaded()) return true;
    await sleep(1000);
  }
  run(["launchctl", "load", "-w", plist]);
  return launchdIsLoaded();
}

// bootout returns before the unit is gone; wait for it, so a bootstrap right after cannot collide.
async function launchdUnload(plist: string): Promise<void> {
  if (run(["launchctl", "bootout", `gui/${uid()}/${SERVICE_LABEL}`]).code !== 0 && existsSync(plist)) {
    run(["launchctl", "unload", "-w", plist]);
  }
  for (let i = 0; i < 20 && launchdIsLoaded(); i++) await sleep(500);
}

async function launchdInstall(): Promise<number> {
  const plist = launchdWritePlist();
  if (!plist) return 127;
  await launchdUnload(plist);
  if (!(await launchdLoad(plist))) return (err(`service: launchctl could not load ${plist}\n`), 1);
  out(`installed launchd agent ${SERVICE_LABEL}\n  plist: ${plist}\n`);
  return 0;
}

async function launchdUninstall(): Promise<number> {
  const plist = launchdPlist();
  await launchdUnload(plist);
  if (existsSync(plist)) {
    if (!removeFile(plist)) return (err(`service: could not remove ${plist}\n`), 1);
    out(`removed ${plist}\n`);
  } else out("service: no launchd agent installed\n");
  return 0;
}

function launchdSupervisorState(): void {
  const r = run(["launchctl", "print", `gui/${uid()}/${SERVICE_LABEL}`]);
  if (r.code !== 0) return out("  not loaded\n");
  let state = false;
  let pid = false;
  for (const line of r.out.split("\n")) {
    const t = line.trim();
    if (!state && t.startsWith("state = ")) (out(`  ${t}\n`), (state = true));
    if (!pid && t.startsWith("pid = ")) (out(`  ${t}\n`), (pid = true));
  }
}

// ---- systemd --user (Linux) ----

function systemdWriteUnit(): string | null {
  const bun = bunPath();
  if (!bun) return null;
  const unit = unitPath();
  mkdirSync(dirname(unit), { recursive: true });
  const log = logFile();
  writeFileSync(
    unit,
    `[Unit]
Description=orch dashboard server
Documentation=https://github.com/barnuri/orch-skill
After=network.target

[Service]
Type=simple
ExecStart=${bun} ${DISPATCH} serve
Environment=HARNESS_ORCH_HOME=${orchHome}
Environment=ORCH_BUN=${bun}
Environment=PATH=${pathValue(bun, "")}
WorkingDirectory=${SKILL_DIR}
Restart=always
KillMode=process
RestartSec=${THROTTLE_SECS}
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`,
  );
  return unit;
}

function systemdInstall(): number {
  const unit = systemdWriteUnit();
  if (!unit) return 127;
  if (run(["systemctl", "--user", "daemon-reload"]).code !== 0) return 1;
  if (run(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT_NAME]).code !== 0) {
    err(`service: systemctl could not enable ${SYSTEMD_UNIT_NAME}\n`);
    return 1;
  }
  out(`installed systemd --user unit ${SYSTEMD_UNIT_NAME}\n  unit: ${unit}\n`);
  out(`  tip: \`loginctl enable-linger ${run(["id", "-un"]).out.trim()}\` keeps it running when you are logged out\n`);
  return 0;
}

function systemdUninstall(): number {
  const unit = unitPath();
  run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT_NAME]);
  if (existsSync(unit)) {
    if (!removeFile(unit)) return (err(`service: could not remove ${unit}\n`), 1);
    run(["systemctl", "--user", "daemon-reload"]);
    out(`removed ${unit}\n`);
  } else out("service: no systemd unit installed\n");
  return 0;
}

function systemdSupervisorState(): void {
  const en = run(["systemctl", "--user", "is-enabled", SYSTEMD_UNIT_NAME]).out.trim();
  const ac = run(["systemctl", "--user", "is-active", SYSTEMD_UNIT_NAME]).out.trim();
  if (en) out(`  enabled: ${en}\n`);
  if (ac) out(`  active: ${ac}\n`);
}

// ---- subcommands ----

function authSummary(): void {
  if (requireToken && !allowRemote) out("  auth:    bearer token required from every peer, loopback included\n");
  else if (requireToken) out("  auth:    bearer token required from this machine; none from other peers\n");
  else if (allowRemote) out("  auth:    none from any peer\n");
  else out("  auth:    none from this machine; the bearer token from any other peer\n");
}

function printConfigBlock(): void {
  out(`  config:  ${orchHome}/serve.json\n`);
  out(`  serving: ${host}:${port}\n  state:   ${orchHome}\n  log:     ${logFile()}\n`);
  authSummary();
}

async function cmdInstall(args: string[]): Promise<number> {
  const bad = parseInstallOpts(args);
  if (bad) return bad;
  const backend = platform();
  if (!backend) return 1;
  const pre = preflight();
  if (pre) return pre;
  if (!persistServeConfig()) return 1;
  loadServeConfig();

  if (unitInstalledForCheckout() && configSetArgs.length === 0) {
    out("service: already installed for this checkout (state and serve.json unchanged)\n");
    printConfigBlock();
    out(`\nDashboard: ${dashboardUrl()}\n`);
    return 0;
  }
  const rc = backend === "launchd" ? await launchdInstall() : systemdInstall();
  if (rc) return 1;
  printConfigBlock();
  if (host === "0.0.0.0" && !allowRemote) out("  note: bound to 0.0.0.0 — reachable from your LAN with the token\n");
  else if (host === "0.0.0.0") out("  note: bound to 0.0.0.0 — reachable from your LAN without a token\n");
  out(`\nDashboard: ${dashboardUrl()}\n`);
  out(`Check it with: ${SELF} status\n`);
  return 0;
}

async function cmdUninstall(): Promise<number> {
  const backend = platform();
  if (!backend) return 1;
  return backend === "launchd" ? await launchdUninstall() : systemdUninstall();
}

async function cmdRestart(): Promise<number> {
  const backend = platform();
  if (!backend) return 1;
  loadServeConfig();
  if (!existsSync(unitPath())) return (err(`service: nothing installed — run \`${SELF} install\` first\n`), 1);
  if (backend === "launchd") {
    // A loaded unit is restarted in place: no window where nothing is loaded.
    if (!(launchdIsLoaded() && run(["launchctl", "kickstart", "-k", `gui/${uid()}/${SERVICE_LABEL}`]).code === 0)) {
      await launchdUnload(launchdPlist());
      if (!(await launchdLoad(launchdPlist()))) return (err(`service: launchd could not load ${launchdPlist()}\n`), 1);
    }
  } else if (run(["systemctl", "--user", "restart", SYSTEMD_UNIT_NAME]).code !== 0) return 1;
  out(`service: restarted (config: ${orchHome}/serve.json)\n`);
  return 0;
}

async function cmdStatus(): Promise<number> {
  const backend = platform();
  if (!backend) return 1;
  loadServeConfig();
  out(`config: ${orchHome}/serve.json\nunit: ${unitPath()}\n`);
  if (!existsSync(unitPath())) return (out(`service: not installed — run \`${SELF} install\`\n`), 1);
  out("supervisor:\n");
  if (backend === "launchd") launchdSupervisorState();
  else systemdSupervisorState();
  out(`listener on 127.0.0.1:${port}: `);
  out((await listening()) ? "answering\n" : `no answer — see ${logFile()}\n`);
  authSummary();
  out(`dashboard: ${dashboardUrl()}\n`);
  // HTTPS is opt-in; the checks above stay on plain HTTP.
  out(`http: http://${osHostname()}:${port}/\n${formatHttpsLine(readTlsStatus(orchHome), readTlsConfig(orchHome).httpsPort, osHostname())}\n`);
  return 0;
}

function cmdLogs(args: string[]): number {
  let lines = 40;
  if (args[0] === "-n") {
    if (!isUint(args[1])) return (err("service: -n expects a line count\n"), 2);
    lines = Number(args[1]);
  }
  const log = logFile();
  if (!existsSync(log)) return (err(`service: no log at ${log} yet\n`), 1);
  out(readFileSync(log, "utf8").split("\n").slice(-lines - 1).join("\n"));
  return 0;
}

const [sub = "", ...rest] = process.argv.slice(2);
let code: number;
switch (sub) {
  case "install": code = await cmdInstall(rest); break;
  case "uninstall": code = await cmdUninstall(); break;
  case "restart": code = await cmdRestart(); break;
  case "status": code = await cmdStatus(); break;
  case "logs": code = cmdLogs(rest); break;
  case "-h": case "--help": case "help": case "": usage(out); code = 0; break;
  default:
    err(`service: unknown subcommand ${sub}\n\n`);
    usage(err);
    code = 2;
}
process.exit(code);
