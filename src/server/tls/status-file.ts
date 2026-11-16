import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeAtomic } from "../files/atomic-write";
import { type TlsStatus } from "./manager";

const file = (home: string): string => join(home, "serve", "tls.json");

/** Public status for the CLI (a separate process). Holds no key. */
export function writeTlsStatus(home: string, status: TlsStatus): void {
  try {
    writeAtomic(home, file(home), new TextEncoder().encode(JSON.stringify(status)));
  } catch {
    // status is advisory; never stop the server over it
  }
}

export function readTlsStatus(home: string): TlsStatus | null {
  try {
    return existsSync(file(home)) ? (JSON.parse(readFileSync(file(home), "utf8")) as TlsStatus) : null;
  } catch {
    return null;
  }
}

export function formatHttpsLine(status: TlsStatus | null, httpsPort: number, host: string): string {
  if (httpsPort === 0) return "https: off";
  if (status === null || !status.listening) {
    return `https: down (port ${httpsPort})${status?.problem ? ` — ${status.problem}` : ""}`;
  }
  const exp = status.not_after === null ? "" : `, expires ${status.not_after.slice(0, 10)}`;
  const warn = status.warning === null ? "" : `, ${status.warning}`;
  return `https: https://${host}:${status.port}/ (cert: ${status.source}${exp}${warn})`;
}
