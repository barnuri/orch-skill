import { closeSync, existsSync, openSync, readSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { runUrl, schedulesUrl } from "../../shared/push";
import type { NodeStatus } from "../../shared/types/node-status";
import { orchPaths } from "../files/paths";
import { listRunIds, readRun } from "../runs/runs-reader";
import type { NotifyInput } from "./hub";
import type { PushCategory } from "../../shared/push";

type Notify = (category: PushCategory, input: NotifyInput) => unknown;

interface RunSeen {
  status: string;
  nodes: Map<string, NodeStatus>;
}

function stateMtimeOf(runDir: string): number | null {
  try {
    return statSync(join(runDir, "state.json")).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Orch runs, watchdog flags and schedule fires as notifications. It only reads what orch already writes
 * (`runs/*\/state.json`, `watchdog/actions.log`, `schedules/*\/claims`), so the engine and the watchdog stay untouched.
 * The first scan only learns the current state: nothing that happened before the server started is announced.
 */
export class RunWatcher {
  private readonly runs = new Map<string, RunSeen>();
  private readonly stateMtime = new Map<string, number>();
  private readonly claims = new Set<string>();
  private logOffset = 0;
  private primed = false;

  constructor(private readonly home: string, private readonly notify: Notify) {}

  scan(): void {
    this.scanRuns();
    this.scanWatchdog();
    this.scanSchedules();
    this.primed = true;
  }

  private scanRuns(): void {
    const paths = orchPaths(this.home);
    const ids = listRunIds(paths.runs);
    for (const id of ids) {
      // An unchanged state.json has no transition to announce: skip the parse and the activity scan.
      const mtime = stateMtimeOf(join(paths.runs, id));
      if (mtime !== null && this.stateMtime.get(id) === mtime && this.runs.has(id)) continue;
      const res = readRun(paths, id);
      if (res.kind !== "ok") continue;
      if (mtime !== null) this.stateMtime.set(id, mtime);
      const run = res.run;
      if ((run as { muted?: boolean }).muted === true) {
        this.runs.set(id, { status: run.status, nodes: new Map(run.nodes.map((n) => [n.id, n.status])) });
        continue;
      }
      const prev = this.runs.get(id);
      const nodes = new Map<string, NodeStatus>(run.nodes.map((n) => [n.id, n.status]));
      this.runs.set(id, { status: run.status, nodes });
      if (!this.primed) continue;
      // A run that appears after priming starts with its nodes unseen, so its first transitions still count.
      const before: RunSeen = prev ?? { status: "running", nodes: new Map() };
      const seenNodes = before.nodes;
      const url = runUrl(id);
      const title = run.title === "" ? "Orch run" : run.title;
      for (const node of run.nodes) {
        const was = seenNodes.get(node.id);
        if (was === node.status || (was === undefined && node.status === "waiting")) continue;
        if (node.status === "done" && was !== "done") {
          this.notify("runs", { title, body: `Task finished: ${node.label}`, tag: `run:${id}:${node.id}`, url, runId: id });
        } else if (node.status === "error" && was !== "error") {
          this.notify("failures", { title, body: `Task failed: ${node.label}`, tag: `run:${id}:${node.id}`, url, runId: id });
        }
      }
      if (before.status === "running" && run.status !== "running") {
        const ok = run.status === "done";
        this.notify(ok ? "runs" : "failures", {
          title,
          body: ok ? "The run finished." : run.status === "cancelled" ? "The run was cancelled." : "The run failed.",
          tag: `run:${id}`,
          url,
          runId: id,
        });
      }
    }
  }

  private scanWatchdog(): void {
    const file = join(this.home, "watchdog", "actions.log");
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (!this.primed || size < this.logOffset) {
      this.logOffset = size;
      return;
    }
    if (size === this.logOffset) return;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(size - this.logOffset);
    try {
      readSync(fd, buf, 0, buf.length, this.logOffset);
    } finally {
      closeSync(fd);
    }
    const end = buf.lastIndexOf(10);
    if (end < 0) return;
    this.logOffset += end + 1;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      try {
        const a = JSON.parse(line) as { run?: string; node?: string | null; rule?: string; action?: string; detail?: string };
        if (a.action !== "flag" || a.run === undefined) continue;
        const rule = a.rule ?? "flag";
        this.notify("failures", {
          title: "Orch watchdog",
          body: `${a.node ?? "A task"}: ${rule}${a.detail === undefined ? "" : ` (${a.detail})`}`,
          tag: `watchdog:${a.run}:${a.node ?? ""}:${rule}`,
          url: runUrl(a.run),
          runId: a.run,
        });
      } catch {
        // a torn line: skipped
      }
    }
  }

  private scanSchedules(): void {
    const root = join(this.home, "schedules");
    let ids: string[] = [];
    try {
      ids = readdirSync(root);
    } catch {
      return;
    }
    for (const id of ids) {
      let names: string[] = [];
      try {
        names = readdirSync(join(root, id, "claims"));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!/^\d+$/.test(name)) continue;
        const key = `${id}@${name}`;
        if (this.claims.has(key)) continue;
        this.claims.add(key);
        if (!this.primed || scheduleMuted(root, id)) continue;
        this.notify("schedules", { title: "Orch schedule", body: `Schedule ${scheduleName(root, id)} fired.`, tag: `schedule:${id}`, url: schedulesUrl() });
      }
    }
  }
}

function scheduleMuted(root: string, id: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(root, id, "schedule.json"), "utf8")) as { muted?: boolean }).muted === true;
  } catch {
    return false;
  }
}

function scheduleName(root: string, id: string): string {
  try {
    const s = JSON.parse(readFileSync(join(root, id, "schedule.json"), "utf8")) as { name?: string; title?: string };
    return s.name ?? s.title ?? id;
  } catch {
    return id;
  }
}

const POLL_MS = 5000;

export function startRunWatcher(home: string, notify: Notify, pollMs = POLL_MS): () => void {
  const watcher = new RunWatcher(home, notify);
  const tick = (): void => {
    try {
      watcher.scan();
    } catch (err) {
      console.error(`push: run watcher scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  tick();
  const timer = setInterval(tick, pollMs);
  timer.unref();
  return () => clearInterval(timer);
}
