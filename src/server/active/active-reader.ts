import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ActiveItem } from "../../shared/types/active-item";
import { watchProcessAlive } from "./watch-liveness";

const LOOPS_DIR: string = "loops";
const WATCHES_DIR: string = "watches";

type Json = Record<string, unknown>;

function readJson(path: string): Json | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}

function idsIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

// `kill -0` equivalent: signal 0 only checks that the process exists and may be signalled.
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

function chatOf(spec: Json): { chat_id: string } | Record<string, never> {
  const target = spec["target"];
  const id = typeof target === "object" && target !== null && !Array.isArray(target) ? (target as Json)["chat_id"] : undefined;
  return typeof id === "string" ? { chat_id: id } : {};
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);
const str = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);

function loopItem(home: string, id: string): ActiveItem | null {
  const dir = join(home, LOOPS_DIR, id);
  const state = readJson(join(dir, "state.json"));
  const spec = readJson(join(dir, "spec.json"));
  if (state === null || spec === null) {
    return null;
  }
  // A recorded "running" with no process behind it is "lost" — except a demo loop, which never had one.
  const recorded = str(state["status"], "");
  const lost = recorded === "running" && !pidAlive(state["pid"]) && spec["demo"] !== true && state["demo"] !== true;
  const status = lost ? "lost" : recorded;
  if (status !== "running" && status !== "failed" && status !== "lost") {
    return null;
  }
  return {
    kind: "loop",
    id: str(state["id"], id),
    name: str(spec["label"], "") || str(spec["name"], ""),
    status,
    reason: typeof state["reason"] === "string" ? state["reason"] : null,
    started: str(spec["started"], ""),
    interval: num(spec["interval"], 0),
    deadline: num(spec["deadline"], 0),
    ...chatOf(spec),
    iteration: num(state["iteration"], 0),
    max: num(spec["max"], 0),
    next: num(state["next_tick"], 0),
    last_exit: typeof state["last_exit"] === "number" ? state["last_exit"] : null,
    session: str(spec["session_mode"], ""),
    skipped: num(state["skipped"], 0),
    when_idle: spec["when_idle"] === true,
  };
}

function watchItem(home: string, id: string): ActiveItem | null {
  const dir = join(home, WATCHES_DIR, id);
  const state = readJson(join(dir, "state.json"));
  const spec = readJson(join(dir, "spec.json"));
  if (state === null || spec === null) {
    return null;
  }
  const recorded = str(state["status"], "");
  // A recorded "running" whose process is gone (or whose pid now belongs to another process) is
  // dead: `dispatch.ts` records it so on its next read, and it is left out here as it is there.
  // "lost" is what older versions recorded for a streaming watch that lost its process.
  const shown = recorded === "lost" || (recorded === "running" && watchProcessAlive(state["pid"], id));
  if (!shown) {
    return null;
  }
  const status = recorded === "lost" ? "lost" : "running";
  return {
    kind: "watch",
    id: str(state["id"], id),
    name: str(spec["name"], ""),
    status,
    reason: typeof state["reason"] === "string" ? state["reason"] : null,
    started: str(spec["started"], ""),
    interval: num(spec["interval"], 0),
    deadline: num(spec["deadline"], 0),
    events: num(state["events"], 0),
    last_event: typeof state["last_event"] === "string" ? state["last_event"] : null,
    cmd: str(spec["cmd"], ""),
    ...chatOf(spec),
  };
}

/**
 * Running loops and monitors, plus any that failed or lost their process (those need attention).
 * A direct read of the state files `dispatch.ts` writes: it takes about a millisecond, where
 * spawning `dispatch.ts active --json` took 0.1 to 0.7 s and ran on every poll of every page.
 * Liveness is the same check the shell uses: `kill -0` on the recorded pid, and for a watch also its
 * command line naming the watch (watch-liveness.ts).
 */
export function readActive(home: string): ActiveItem[] {
  const items: ActiveItem[] = [];
  for (const id of idsIn(join(home, LOOPS_DIR))) {
    const item = loopItem(home, id);
    if (item !== null) {
      items.push(item);
    }
  }
  for (const id of idsIn(join(home, WATCHES_DIR))) {
    const item = watchItem(home, id);
    if (item !== null) {
      items.push(item);
    }
  }
  return items;
}
