import type { Server } from "bun";
import type { ServerOptions } from "./types/server-options";
import { resolve } from "node:path";

import { buildApp, startHttpsServer, startServer } from "./app";
import { readTlsConfig } from "./tls/config";
import { TlsManager } from "./tls/manager";
import { writeTlsStatus } from "./tls/status-file";
import type { TlsMaterial } from "./tls/sources";
import { startCliSocket } from "./cli-socket";
import { SERVE_USAGE, parseServeArgs, urlsFor } from "./cli";
import { ensureHome } from "./files/ensure-home";
import { clearPidMarker, writeServeMarkers } from "./files/marker-files";
import { ensureToken } from "./files/token-file";
import { startHerdrWatcher } from "./health/herdr-watcher";
import { digestToken } from "./http/auth";
import { orchPaths } from "./files/paths";
import { startBootResume } from "./runs/boot-resume";
import { pauseRunsOnShutdown } from "./runs/shutdown-pause";
import { startTicker } from "./schedules/ticker";
import { pushHubFor } from "./push/hub";
import { startRunWatcher } from "./push/run-watcher";
import { startWatchdog } from "./watchdog/watchdog-service";
import { startOrchestratorRotation } from "./watchdog/orchestrator-rotation";
import { startHubModelSync } from "./models/hub-sync";

export const MIN_BUN: string = ">=1.3.0";
export const EXIT_OK: number = 0;
export const EXIT_FAIL: number = 1;
export const EXIT_USAGE: number = 2;

const TEMPLATES_DIR: string = resolve(import.meta.dir, "../../skills/orch/templates");
const SHUTDOWN_SIGNALS = ["SIGINT", "SIGTERM"] as const;
const BIND_CODES = ["EADDRINUSE", "EACCES", "EADDRNOTAVAIL"] as const;

function bindCodeOf(err: unknown): string | null {
  if (!(err instanceof Error)) {
    return null;
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && BIND_CODES.includes(code as (typeof BIND_CODES)[number])
    ? code
    : null;
}

// Plain HTTP is a deliberate trade-off, so the risk is restated on every boot rather than
// buried in a doc. stderr, not stdout: bash `ui` tails the log but only echoes its own URL.
function banner(
  home: string,
  host: string,
  port: number,
  requireToken: boolean,
  requireRemoteToken: boolean,
): string {
  const reach = reachSummary(requireToken, requireRemoteToken);
  const hints: string[] = [];
  if (!requireToken) {
    hints.push("Pass --require-token to demand it locally too.");
  }
  if (requireRemoteToken) {
    hints.push("Pass --allow-remote to drop the token requirement for other peers.");
  }
  return [
    `serve: plain HTTP on ${host}:${port} — ${reach}.`,
    `Token: ${home}/serve.token (0600); trash it and restart to rotate.`,
    ...hints,
    "Ctrl-C to stop.",
  ].join(" ");
}

function reachSummary(requireToken: boolean, requireRemoteToken: boolean): string {
  if (!requireToken && !requireRemoteToken) {
    return "every request is unauthenticated";
  }
  if (!requireToken && requireRemoteToken) {
    return "requests from this machine need no token; anyone else on the network needs it";
  }
  if (requireToken && !requireRemoteToken) {
    return "requests from this machine need the bearer token; anyone else on the network needs none";
  }
  return "every request needs the bearer token";
}

function onShutdown(server: Server<undefined>, home: string): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      // SIGTERM is a PC restart or logout: pause each running run with auto_resume so boot-resume
      // picks it up on the next start. Node jobs are left alone. Bounded and never rejects.
      const paused = signal === "SIGTERM" ? pauseRunsOnShutdown(home) : Promise.resolve([]);
      void Promise.all([paused, server.stop(true)]).finally(() => {
        // Truncated only when it still holds our pid, so a restart that already claimed the
        // marker is never clobbered. The file itself stays — `serve_running` expects it.
        clearPidMarker(home, process.pid);
        process.exit(EXIT_OK);
      });
    });
  }
}

/**
 * Foreground entrypoint: `dispatch.ts serve` execs it, `ui` nohups it. Owns the whole
 * lifecycle — seed ORCH_HOME, mint the token, bind, publish the `serve/` markers bash polls —
 * and never opens a browser; bash `ui` does that.
 */
export async function main(argv: readonly string[]): Promise<number> {
  if (!Bun.semver.satisfies(Bun.version, MIN_BUN)) {
    process.stderr.write(`serve: Bun >= 1.3 required (found ${Bun.version})\n`);
    return EXIT_FAIL;
  }

  let args;
  try {
    args = parseServeArgs(argv);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`usage: ${SERVE_USAGE}\n`);
    return EXIT_USAGE;
  }

  ensureHome(args.home, TEMPLATES_DIR);
  const token = ensureToken(args.home);

  // HTTPS is opt-in: the manager exists only when https_port is non-zero, and nothing is generated before.
  const tlsConfig = readTlsConfig(args.home);
  const manager = tlsConfig.httpsPort > 0
    ? new TlsManager(args.home, tlsConfig, (m) => void swapHttps(m).catch(() => {}))
    : null;
  let httpsServer: Server<undefined> | null = null;
  let options: ServerOptions;

  const publish = (): void => {
    if (manager !== null) writeTlsStatus(args.home, manager.status());
  };
  const bindHttps = (m: TlsMaterial): void => {
    if (manager === null) return;
    try {
      httpsServer = startHttpsServer(options, tlsConfig.httpsPort, { cert: m.cert, key: m.key }, api);
      manager.setListening(true);
    } catch (err) {
      httpsServer = null;
      const code = bindCodeOf(err);
      manager.setListening(false, code === null ? "HTTPS listener failed to start (certificate rejected)" : `cannot bind HTTPS port ${tlsConfig.httpsPort}: ${code}`);
    }
    publish();
  };
  async function swapHttps(m: TlsMaterial): Promise<void> {
    if (httpsServer !== null) await httpsServer.stop(true);
    httpsServer = null;
    bindHttps(m);
  }

  let server: Server<undefined>;
  let api: ReturnType<typeof buildApp>;
  try {
    options = {
      home: args.home,
      host: args.host,
      port: args.port,
      tokenDigest: digestToken(token),
      requireToken: args.requireToken,
      requireRemoteToken: args.requireRemoteToken,
      harnesses: args.harnesses,
      outcomes: args.outcomes,
      httpsPort: tlsConfig.httpsPort,
      secureLinkHint: tlsConfig.secureLinkHint,
      ...(manager === null ? {} : { tls: manager }),
    };
    api = buildApp(options);
    server = startServer(options, api);
  } catch (err) {
    const code = bindCodeOf(err);
    if (code === null) {
      throw err;
    }
    process.stderr.write(`serve: cannot bind ${args.host}:${args.port}: ${code}\n`);
    return EXIT_FAIL;
  }

  // `server.port` is undefined only for a unix-socket bind, which this server never does.
  const port = server.port ?? args.port;
  // Handlers first: a SIGTERM that lands while the background workers start must still stop cleanly.
  onShutdown(server, args.home);
  // pid lands last: bash treats a pid marker as proof the port is already bound.
  writeServeMarkers(args.home, { host: args.host, port, pid: process.pid });

  // The only place the token is printed.
  for (const url of urlsFor(args.host, port, token, args.requireToken, args.requireRemoteToken)) {
    process.stdout.write(`${url}\n`);
  }
  process.stderr.write(
    `${banner(args.home, args.host, port, args.requireToken, args.requireRemoteToken)}\n`,
  );

  const cliSocket = startCliSocket(args.home);
  if (cliSocket) process.on("exit", () => cliSocket.stop());
  if (manager !== null) {
    // After HTTP is up: any failure here (certificate code, port busy) only ever costs the HTTPS listener.
    try {
      const m = await manager.load();
      if (m !== null) {
        bindHttps(m);
        process.stderr.write(`serve: HTTPS on port ${tlsConfig.httpsPort} (opt-in; HTTP stays the default)\n`);
      } else {
        process.stderr.write(`serve: HTTPS is off: ${manager.status().problem ?? "no certificate"}\n`);
        publish();
      }
      manager.startTimer();
      process.on("SIGHUP", () => void manager.check().then(publish).catch(() => {}));
    } catch (err) {
      process.stderr.write(`serve: HTTPS is off: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  startTicker(args.home);
  startHerdrWatcher(args.home);
  // Event-driven watchdog: owns the auto-dispatch engine (ready nodes, done/error pushes) and the
  // lost, stalled, unverified, infra-retry and finish rules.
  startWatchdog(args.home);
  // Rotates a coordinator session at settings.coordinator_rotate_tokens (reads its prompt size from opencode.db).
  startOrchestratorRotation(args.home);
  // Run, watchdog and schedule notifications: read-only on orch state, sent only to the browser push services of subscriptions.
  startRunWatcher(args.home, (category, input) => void pushHubFor(args.home).notify(category, input).catch(() => {}));
  // A run paused with auto_resume (a PC restart) resumes by itself; never blocks or crashes boot.
  startBootResume(args.home);
  // Refreshes the llm-hub model list in the catalog at every start. Background, never blocks boot.
  startHubModelSync(args.home);
  // Resolves only on an unhandled fault; the signal handlers exit the process.
  await new Promise<never>(() => {});
  return EXIT_OK;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
