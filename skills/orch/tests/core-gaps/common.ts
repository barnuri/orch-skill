import { setDefaultTimeout } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import { orch, seedHome, runState, editJson } from "../helpers";

/** A home with run `r1` holding nodes a (waiting) and b (waiting, after a). */
export function runHome(env: Record<string, string | undefined> = {}) {
  const home = seedHome();
  const o = orch(home, { HERDR_PANE_ID: undefined, HERDR_SOCKET_PATH: undefined, ...env });
  setDefaultTimeout(120000);
  o("run", "start", "Gap", "--id", "r1");
  o("node", "add", "r1", "a", "A", "--profile", "claude-default");
  o("node", "add", "r1", "b", "B", "--after", "a", "--profile", "claude-default");
  const st = () => runState(home, "r1");
  const node = (id: string) => st().nodes.find((n: any) => n.id === id);
  return { home, o, st, node };
}

/** A finished job dir for `job` with the given exit code. */
export function fakeJob(home: string, job: string, exit = 0) {
  const d = join(home, "jobs", job);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "exit_code"), `${exit}\n`);
  writeFileSync(join(d, "log"), "log line\n");
}

export const setNode = (home: string, id: string, patch: Record<string, unknown>) =>
  editJson(join(home, "runs/r1/state.json"), (s) => { Object.assign(s.nodes.find((n: any) => n.id === id), patch); });
