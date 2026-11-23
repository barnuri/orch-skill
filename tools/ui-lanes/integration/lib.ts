// Shared helpers for the integration lane and its isolation proofs. Bun only. Never names the live orch home.
// fingerprint() reads metadata (names, sizes, mtimes) of a directory it is given, never file contents.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_PORT = 6724;
export const DISPATCH = fileURLToPath(new URL("../../../skills/orch/scripts/dispatch.ts", import.meta.url));
export const LANE_RUN_ID = "lane-run";
export const LANE_RUN_TITLE = "Lane run";

/** Hash of every path, size and mtime under `dir`. Returns "absent" when `dir` does not exist. */
export function fingerprint(dir: string): string {
  if (!existsSync(dir)) return "absent";
  const hash = createHash("sha256");
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      let st;
      try {
        st = statSync(path);
      } catch {
        continue; // removed between readdir and stat
      }
      hash.update(`${relative(dir, path)}\0${st.size}\0${st.mtimeMs}\0${st.isDirectory() ? "d" : "f"}\n`);
      if (st.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return hash.digest("hex");
}

/** A TCP port the OS assigns right now. Released before return; the caller binds it next. */
export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = server.port;
  server.stop(true);
  return port;
}

/** Runs `dispatch.ts` against `home` with HOME set to `sandboxHome`, so a stray `~` write lands in the sandbox. */
async function dispatchIn(home: string, sandboxHome: string, args: string[]): Promise<void> {
  const proc = Bun.spawn(["bun", DISPATCH, ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: sandboxHome, HARNESS_ORCH_HOME: home, ORCH_HERDR: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`dispatch ${args.join(" ")} failed (${code}): ${await new Response(proc.stderr).text()}`);
  }
}

/** Seeds a fresh orch home with one running run. Fixed run id and title, so the Playwright assertions are stable. */
export async function seedLaneHome(home: string, sandboxHome: string): Promise<void> {
  mkdirSync(home, { recursive: true });
  mkdirSync(sandboxHome, { recursive: true });
  await dispatchIn(home, sandboxHome, ["init"]);
  await dispatchIn(home, sandboxHome, ["run", "start", LANE_RUN_TITLE, "--id", LANE_RUN_ID]);
}

/** Throws unless `port` is a usable port other than the live service port. Shared by run.ts and the tests. */
export function assertLanePort(port: number): number {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`lane port must be 1-65535, got ${port}`);
  if (port === LIVE_PORT) throw new Error(`refusing to use the live service port ${LIVE_PORT}`);
  return port;
}
