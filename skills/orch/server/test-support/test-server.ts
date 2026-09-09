import { startServer } from "../app";
import { digestToken } from "../http/auth";
import type { ServerOptions } from "../types/server-options";
import type { TestServerHandle } from "../types/test-server-handle";
import { TempHome } from "./temp-home";

export const TEST_TOKEN: string = "orch-test-token";

// Mirrors the enum lists bash passes on the real command line (templates/profiles.json uses all four).
const TEST_HARNESSES: readonly string[] = ["claude", "cursor-agent", "opencode", "local-llm"];
const TEST_OUTCOMES: readonly string[] = ["success", "failure", "partial"];
const LOOPBACK_HOST: string = "127.0.0.1";
const WILDCARD_HOST: string = "0.0.0.0";

/**
 * In-process server on 127.0.0.1:0 over a fresh TempHome, authenticated with a known
 * token. `overrides` replace individual `ServerOptions` (never the bind to all interfaces);
 * `stop()` closes the server and moves the TempHome to the Trash.
 *
 * `requireToken` defaults to true even though these tests connect over loopback: without it the
 * loopback bypass would authorize every request and each auth assertion would pass vacuously.
 * Tests for the bypass itself opt out with `{ requireToken: false }`.
 */
export function startTestServer(overrides: Partial<ServerOptions> = {}): TestServerHandle {
  if (overrides.host === WILDCARD_HOST) {
    throw new Error(`test server must not bind ${WILDCARD_HOST}`);
  }
  const home = TempHome.create();
  const server = startServer({
    home: home.path,
    host: LOOPBACK_HOST,
    port: 0,
    tokenDigest: digestToken(TEST_TOKEN),
    requireToken: true,
    requireRemoteToken: true,
    harnesses: TEST_HARNESSES,
    outcomes: TEST_OUTCOMES,
    ...overrides,
  });
  const url = `http://${LOOPBACK_HOST}:${server.port}`;
  return {
    server,
    url,
    token: TEST_TOKEN,
    home,
    api: (path: string, init: RequestInit = {}, auth: boolean = true): Promise<Response> => {
      const headers = new Headers(init.headers);
      if (auth) {
        headers.set("Authorization", `Bearer ${TEST_TOKEN}`);
      }
      return fetch(new URL(path, url), { ...init, headers });
    },
    stop: (): void => {
      server.stop(true);
      home.dispose();
    },
  };
}
