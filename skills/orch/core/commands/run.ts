// `orch run status <run-id> [--json] [--fresh]`. Ported from cmd_run_status (lib/runs/visibility.sh).
// Owner verification (lib/runs/owners.sh owners_verify_run) is not ported yet: owner lines are empty.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadRun } from "../state/store.ts";
import { paths, orchHome } from "../state/home.ts";
import { activityRows, staleMinutes, staleNodes, isoToEpoch } from "../state/timing.ts";

// CLI handler: writes stdout/stderr and returns the exit code.
export async function runStatusCommand(args: string[]): Promise<number> {
  const r = await runStatusText(orchHome(), args);
  if (r.out) process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  return r.code;
}

export const RUN_STATUS_USAGE = "usage: dispatch.sh run status <run-id> [--json] [--fresh]";

// The `node_ready` rule (lib/core/config.sh NODE_READY_JQ_DEF).
export function nodeReady(run: any, x: any): boolean {
  if (x.status !== "waiting") return false;
  if (((x.needs_user ?? "") as string) !== "") return false;
  if (((x.hold ?? "") as string) !== "") return false;
  for (const [src, dst] of run.edges ?? []) {
    if (dst !== x.id) continue;
    const s = (run.nodes ?? []).find((n: any) => n.id === src);
    if (s && s.status !== "done") return false;
  }
  if (x.after_all ?? false) {
    for (const n of run.nodes ?? []) {
      if (n.id === x.id || (n.after_all ?? false)) continue;
      if (n.status !== "done" && n.status !== "skipped") return false;
    }
  }
  return true;
}

// jq `age` filter: null -> "?", else seconds / minutes / hours+minutes.
export function age(s: number | null): string {
  if (s === null) return "?";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

// jq `//`: null, false and missing fall through.
const alt = (v: any, d: any) => (v === null || v === undefined || v === false ? d : v);

// run_link: <home>/serve/port when set, else the default port 6724 (serve.sh SERVE_DEFAULT_PORT).
async function servePort(home: string): Promise<string> {
  const text = await readFile(join(home, "serve", "port"), "utf8").catch(() => "");
  return text.trim() === "" ? "6724" : text.trim();
}

export async function runStatusText(home: string, args: string[]): Promise<{ code: number; out: string; err: string }> {
  let runId = "";
  let json = false;
  let fresh = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (a === "--fresh") fresh = true;
    else if (!runId && !a.startsWith("--")) runId = a;
    else return { code: 2, out: "", err: `run status: unknown argument ${a}\n` };
  }
  if (!runId) return { code: 2, out: "", err: RUN_STATUS_USAGE + "\n" };
  const run = await loadRun(home, runId);
  if (!run) return { code: 2, out: "", err: `run ${runId}: unknown run\n` };

  const now = Math.floor(Date.now() / 1000);
  const nowIso = new Date(now * 1000).toISOString().replace(/\.\d+Z$/, "Z");
  const rows = await activityRows(home, runId, run);
  const stale = new Set(staleNodes(rows, await staleMinutes(home), now));
  const byId = new Map(rows.map((r) => [r.id, r]));

  const running = (run.nodes ?? [])
    .filter((n: any) => n.status === "running")
    .map((n: any) => {
      const r = byId.get(n.id)!;
      const ownerRaw = r.owner;
      const started = isoToEpoch(r.started);
      return {
        id: r.id,
        owner: ownerRaw === "-" ? null : ownerRaw,
        age_s: r.started === "-" || started === null ? null : now - started,
        last_activity_s: r.last === null ? null : now - r.last,
        stale: stale.has(r.id),
        note: alt(n.notes?.[n.notes.length - 1]?.text, null),
        progress: alt(n.progress, null),
      };
    });

  const summary = {
    run_id: alt(run.run_id, null),
    title: alt(run.title, null),
    status: alt(run.status, null),
    done: (run.nodes ?? []).filter((n: any) => n.status === "done").length,
    total: (run.nodes ?? []).length,
    running,
    ready: (run.nodes ?? []).filter((n: any) => n.status === "waiting" && nodeReady(run, n)).map((n: any) => n.id),
    errors: (run.nodes ?? []).filter((n: any) => n.status === "error").map((n: any) => ({ id: n.id, error: alt(n.error, null) })),
    link: `http://127.0.0.1:${await servePort(home)}/#/run/${runId}`,
    owner_events: [] as string[],
  };

  const freshLine = fresh ? freshLineOf(run, runId, nowIso, home) : "";
  if (json) {
    if (fresh) return { code: 0, out: JSON.stringify({ ...summary, fresh: freshLine }) + "\n", err: "" };
    return { code: 0, out: JSON.stringify(summary, null, 2) + "\n", err: "" };
  }

  const ageStr = (v: number | null) => age(v);
  const lines: string[] = [];
  if (fresh) lines.push(freshLine);
  lines.push(`${String(summary.title)} [${String(summary.status)}] ${summary.done}/${summary.total} done`);
  for (const r of running) {
    let line = `running ${r.id}: ${ageStr(r.age_s)} in, last activity ${ageStr(r.last_activity_s)} ago`;
    if (r.progress !== null) line += `, ${r.progress}`;
    if (r.note !== null) line += `, "${r.note}"`;
    if (r.stale) line += " [STALE]";
    if (r.owner === null) line += " [UNOWNED: nothing is recorded as doing the work]";
    lines.push(line);
  }
  if (summary.ready.length > 0) lines.push("ready: " + summary.ready.join(","));
  for (const e of summary.errors) lines.push(`error ${e.id}: ${String(alt(e.error, "unknown"))}`);
  lines.push(summary.link);
  return { code: 0, out: lines.join("\n") + "\n", err: "" };
}

// run_fresh_line: read time, run status, node ids grouped by status (group_by sorts by status).
function freshLineOf(run: any, runId: string, nowIso: string, home: string): string {
  const groups = new Map<string, string[]>();
  for (const n of run.nodes ?? []) {
    const g = groups.get(n.status) ?? [];
    g.push(n.id);
    groups.set(n.status, g);
  }
  const parts = [...groups.keys()].sort().map((s) => `${s}=${groups.get(s)!.join(",")}`);
  return `fresh ${nowIso} [${run.status}] ${parts.join(" ")} (read ${paths.runState(home, runId)})`;
}
