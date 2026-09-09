import { existsSync, readFileSync } from "node:fs";

import { writeAtomic } from "./atomic-write";
import { orchPaths } from "./paths";

const utf8: TextEncoder = new TextEncoder();

/** Writes `serve/host`, `serve/port`, then `serve/pid` — bash waits on pid, so it lands last. */
export function writeServeMarkers(
  home: string,
  markers: { host: string; port: number; pid: number },
): void {
  const paths = orchPaths(home);
  writeAtomic(home, paths.hostFile, utf8.encode(markers.host));
  writeAtomic(home, paths.portFile, utf8.encode(String(markers.port)));
  writeAtomic(home, paths.pidFile, utf8.encode(String(markers.pid)));
}

/** Truncates `serve/pid` to empty when it still holds `pid` — never deletes the marker. */
export function clearPidMarker(home: string, pid: number): void {
  const { pidFile } = orchPaths(home);
  if (!existsSync(pidFile)) {
    return;
  }
  if (readFileSync(pidFile, "utf8").trim() !== String(pid)) {
    return;
  }
  writeAtomic(home, pidFile, new Uint8Array(0));
}
