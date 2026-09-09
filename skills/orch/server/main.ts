import type { Server } from "bun";
import { resolve } from "node:path";

import { startServer } from "./app";
import { SERVE_USAGE, parseServeArgs, urlsFor } from "./cli";
import { ensureHome } from "./files/ensure-home";
import { clearPidMarker, writeServeMarkers } from "./files/marker-files";
import { ensureToken } from "./files/token-file";
import { digestToken } from "./http/auth";

export const MIN_BUN: string = ">=1.3.0";
export const EXIT_OK: number = 0;
export const EXIT_FAIL: number = 1;
export const EXIT_USAGE: number = 2;

const TEMPLATES_DIR: string = resolve(import.meta.dir, "../templates");
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
function banner(home: string, host: string, port: number): string {
  return [
    `serve: plain HTTP on ${host}:${port} — anyone on the network holding the token can read`,
    "job logs and edit profiles.",
    `Token: ${home}/serve.token (0600); trash it and restart to rotate. Ctrl-C to stop.`,
  ].join(" ");
}

function onShutdown(server: Server<undefined>, home: string): void {
  for (const signal of SHUTDOWN_SIGNALS) {
    process.on(signal, () => {
      void server.stop(true).then(() => {
        // Truncated only when it still holds our pid, so a restart that already claimed the
        // marker is never clobbered. The file itself stays — `serve_running` expects it.
        clearPidMarker(home, process.pid);
        process.exit(EXIT_OK);
      });
    });
  }
}

/**
 * Foreground entrypoint: `dispatch.sh serve` execs it, `ui` nohups it. Owns the whole
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

  let server: Server<undefined>;
  try {
    server = startServer({
      home: args.home,
      host: args.host,
      port: args.port,
      tokenDigest: digestToken(token),
      harnesses: args.harnesses,
      outcomes: args.outcomes,
    });
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
  // pid lands last: bash treats a pid marker as proof the port is already bound.
  writeServeMarkers(args.home, { host: args.host, port, pid: process.pid });

  // The only place the token is printed.
  for (const url of urlsFor(args.host, port, token)) {
    process.stdout.write(`${url}\n`);
  }
  process.stderr.write(`${banner(args.home, args.host, port)}\n`);

  onShutdown(server, args.home);
  // Resolves only on an unhandled fault; the signal handlers exit the process.
  await new Promise<never>(() => {});
  return EXIT_OK;
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
