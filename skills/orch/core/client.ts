// One request per command to the running dashboard server on <home>/serve/orch.sock. The CLI falls back
// to running the same core function in its own process when the socket is absent, refuses, or does not
// accept a connection within 150 ms. ORCH_DIRECT=1 skips the socket (tests, parity).
import { existsSync } from "node:fs";
import { join } from "node:path";

export const CONNECT_MS = 150;
const CALL_MS = 120_000;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const socketPath = (home: string) => join(home, "serve", "orch.sock");

async function connects(sock: string): Promise<boolean> {
  const conn = await Promise.race([
    Bun.connect({ unix: sock, socket: { data() {}, open() {}, error() {} } }).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), CONNECT_MS)),
  ]);
  if (!conn) return false;
  conn.end();
  return true;
}

// The env the server needs to answer exactly as this process would.
function callerEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && (k.startsWith("ORCH_") || k.startsWith("HARNESS_ORCH") || k === "HOME")) e[k] = v;
  }
  return e;
}

export async function viaServer(home: string, argv: string[]): Promise<CliResult | null> {
  const sock = socketPath(home);
  if (!existsSync(sock) || !(await connects(sock))) return null;
  try {
    const res = await fetch("http://orch/api/cli", {
      unix: sock,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ argv, env: callerEnv() }),
      signal: AbortSignal.timeout(CALL_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as CliResult;
    if (typeof body.code !== "number") return null;
    return body;
  } catch {
    return null;
  }
}
