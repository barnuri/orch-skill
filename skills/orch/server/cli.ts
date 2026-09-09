import { hostname } from "node:os";

import { isLoopbackAddress } from "./http/loopback";
import type { ServeArgs } from "./types/serve-args";

export const DEFAULT_HOST: string = "0.0.0.0";
export const DEFAULT_PORT: number = 6724;
export const MAX_PORT: number = 65535;
export const SERVE_USAGE: string =
  'bun server/main.ts --home DIR [--host H] [--port P] [--require-token] [--allow-remote] --harnesses "a b" --outcomes "x y"';

const LOOPBACK_HOST: string = "127.0.0.1";
const LOCALHOST: string = "localhost";
const UINT_PATTERN: RegExp = /^\d+$/;

/**
 * Parses the `serve` argv (already stripped of the runtime and script path).
 * Every failure throws a plain `Error` whose message carries the usage line;
 * `main.ts` maps any such error to exit 2.
 */
export function parseServeArgs(argv: readonly string[]): ServeArgs {
  let home: string | null = null;
  let host: string = DEFAULT_HOST;
  let port: number = DEFAULT_PORT;
  let requireToken: boolean = false;
  let requireRemoteToken: boolean = true;
  let harnesses: readonly string[] | null = null;
  let outcomes: readonly string[] | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--require-token") {
      requireToken = true;
      continue;
    }
    if (flag === "--allow-remote") {
      requireRemoteToken = false;
      continue;
    }
    const value = valueFor(flag, argv[index + 1]);
    index += 1;
    switch (flag) {
      case "--home":
        home = value;
        break;
      case "--host":
        host = value;
        break;
      case "--port":
        port = parsePort(value);
        break;
      case "--harnesses":
        harnesses = splitEnum(flag, value);
        break;
      case "--outcomes":
        outcomes = splitEnum(flag, value);
        break;
      default:
        throw usageError(`serve: unknown argument ${flag}`);
    }
  }

  if (home === null || home === "") {
    throw usageError("serve: --home is required");
  }
  if (host === "") {
    throw usageError("serve: --host expects a hostname or address");
  }
  if (harnesses === null) {
    throw usageError("serve: --harnesses is required");
  }
  if (outcomes === null) {
    throw usageError("serve: --outcomes is required");
  }
  return { home, host, port, requireToken, requireRemoteToken, harnesses, outcomes };
}

/**
 * URLs to print once the server is listening — the only place the token
 * travels in clear text. `0.0.0.0` yields the loopback URL plus one built from
 * the OS hostname (no DNS lookups); any other bind host yields itself only.
 *
 * A URL only carries `?token=` when the peer reaching the server through it will actually be
 * asked for one: loopback is exempt unless `requireToken` is set, while the hostname URL always
 * carries it because whoever uses it is coming in over the network.
 */
export function urlsFor(
  host: string,
  port: number,
  token: string,
  requireToken: boolean,
  requireRemoteToken: boolean = true,
): string[] {
  if (host !== DEFAULT_HOST) {
    const withToken =
      requireToken || (!isLoopbackHost(host) && requireRemoteToken);
    return [urlOf(host, port, token, withToken)];
  }
  const urls: string[] = [urlOf(LOOPBACK_HOST, port, token, requireToken)];
  const machine = hostname();
  if (machine !== "" && machine !== LOOPBACK_HOST) {
    urls.push(urlOf(machine, port, token, requireRemoteToken));
  }
  return urls;
}

function isLoopbackHost(host: string): boolean {
  return isLoopbackAddress(host) || host.toLowerCase() === LOCALHOST;
}

function urlOf(host: string, port: number, token: string, withToken: boolean): string {
  const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const query = withToken ? `?token=${token}` : "";
  return `http://${authority}:${port}/${query}`;
}

function valueFor(flag: string, next: string | undefined): string {
  if (next === undefined || next.startsWith("--")) {
    throw usageError(`serve: ${flag} expects a value`);
  }
  return next;
}

function parsePort(raw: string): number {
  if (!UINT_PATTERN.test(raw)) {
    throw usageError(`serve: --port expects 0-${MAX_PORT}`);
  }
  const port = Number(raw);
  if (port > MAX_PORT) {
    throw usageError(`serve: --port expects 0-${MAX_PORT}`);
  }
  return port;
}

function splitEnum(flag: string, raw: string): readonly string[] {
  const values = raw.split(/\s+/).filter((value) => value !== "");
  if (values.length === 0) {
    throw usageError(`serve: ${flag} expects at least one value`);
  }
  return values;
}

function usageError(message: string): Error {
  return new Error(`${message}\n  usage: ${SERVE_USAGE}`);
}
