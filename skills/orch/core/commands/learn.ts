// `suggest learn`: scans every run's state for known failure signatures and records each one as an
// "orch-fix" suggestion (in suggestions.json, next to the profile suggestions) with the count, the runs it
// appeared in, and the fix. Read-only on runs; apply the fix through its own command.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { err, out } from "../io.ts";
import { paths } from "../state/home.ts";
import { nowIso } from "../state/clock.ts";
import { orchHome } from "../state/home.ts";

export const LEARN_USAGE = "dispatch.ts suggest learn [--json] [--days N] [--out <path.md>]";

// `commit` is the commit that shipped the fix, or null while the lesson is still open.
export interface Signature { id: string; test: (n: any, run: any) => boolean; fix: string; commit: string | null }

// Each signature is one thing that went wrong in a real run, with the fix that prevents it.
export const SIGNATURES: Signature[] = [
  { id: "ended-early-no-handoff", test: (n) => n.error === "ended early without handoff" || (n.attempts ?? []).some((a: any) => a.error === "ended early without handoff"), fix: "Node prompts must finish with a handoff and a result. The early-end retry now says: decide, wait for background work, then hand off.", commit: "bb8becf" },
  { id: "job-killed-after-work", test: (n) => /exit=(unknown|129|130|143)/.test(String(n.error ?? "")), fix: "A job closed by SIGHUP after writing its handoff counts as done (runs.ts). Never run a background command the job cannot wait for.", commit: "c768875" },
  { id: "covered-dangling", test: (n, run) => n.status === "covered" && !(run.nodes ?? []).some((m: any) => m.id === String(n.covered_by ?? "").split("/").pop()), fix: "A covered node must point to a replacement that exists. Use `node replace` once; do not remove the replacement.", commit: "38cfdb2" },
  { id: "replacement-chain", test: (n) => /-r\d+-r\d+$/.test(n.id ?? ""), fix: "Replacement chains (-r2-r2) mean a node was replaced twice. Replace only an errored node, and only once it used its attempts.", commit: null },
  { id: "no-requirements", test: (n, run) => n.id === "done-gate" && n.status === "done" && !run._hasLedger, fix: "Record every user request with `req add` before the gate; verify now fails a run with no requests.", commit: "589f4f9" },
  { id: "unknown-result", test: (n) => n.result?.verdict === "unknown", fix: "Record a result for each node (`node result`); a node with no result is unknown and must not count as done.", commit: "4f9073d" },
];

export interface Evidence { run: string; node: string; minutes_lost: number }
export interface Lesson { signature: string; count: number; runs: string[]; nodes: string[]; fix: string; commit: string | null; evidence: Evidence[] }

// Minutes a node spent in `error` (from each status change into error to the next status change, or to
// the run's end). Read from the run's events.jsonl; 0 when the run has no events for the node.
export function minutesInError(events: any[], nodeId: string, endMs: number): number {
  let total = 0;
  let since: number | null = null;
  for (const e of events) {
    if (e.node !== nodeId || e.kind !== "status") continue;
    const t = Date.parse(e.at);
    if (Number.isNaN(t)) continue;
    if (since !== null && e.to !== "error") { total += t - since; since = null; }
    else if (since === null && e.to === "error") since = t;
  }
  if (since !== null) total += Math.max(0, endMs - since);
  return Math.round(total / 60000);
}

function readEvents(dir: string): any[] {
  const f = join(dir, "events.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

function runsDir(home: string): string[] {
  const d = paths.runs(home);
  return existsSync(d) ? readdirSync(d) : [];
}

// `sinceMs` keeps only runs started at or after it (null = every run).
export function scanSignatures(home: string, sinceMs: number | null = null): Lesson[] {
  const found: Record<string, { count: number; runs: Set<string>; nodes: string[]; evidence: Evidence[] }> = {};
  for (const runId of runsDir(home)) {
    const dir = join(paths.runs(home), runId);
    const f = join(dir, "state.json");
    if (!existsSync(f)) continue;
    const run = JSON.parse(readFileSync(f, "utf8"));
    const started = Date.parse(run.started ?? "");
    if (sinceMs !== null && !(started >= sinceMs)) continue;
    const ledger = join(dir, "requirements.json");
    run._hasLedger = existsSync(ledger) && JSON.parse(readFileSync(ledger, "utf8")).requirements?.length > 0;
    let events: any[] | null = null;
    const endMs = Date.parse(run.finished ?? "") || Date.now();
    for (const n of run.nodes ?? []) {
      for (const sig of SIGNATURES) {
        if (!sig.test(n, run)) continue;
        const e = (found[sig.id] ??= { count: 0, runs: new Set(), nodes: [], evidence: [] });
        e.count++;
        e.runs.add(runId);
        if (e.nodes.length < 10) e.nodes.push(`${runId}/${n.id}`);
        events ??= readEvents(dir);
        e.evidence.push({ run: runId, node: n.id, minutes_lost: minutesInError(events, n.id, endMs) });
      }
    }
  }
  return SIGNATURES.filter((s) => found[s.id]).map((s) => ({ signature: s.id, count: found[s.id]!.count, runs: [...found[s.id]!.runs], nodes: found[s.id]!.nodes, fix: s.fix, commit: s.commit, evidence: found[s.id]!.evidence }));
}

// The tracked learnings file: one section per lesson with its evidence and fix commit (or "open").
export function learningsMarkdown(rows: Lesson[], days: number | null, generatedAt: string): string {
  const scope = days === null ? "all runs" : `runs started in the last ${days} days`;
  const lines = [`# Run learnings (${scope})`, "", `Generated ${generatedAt} by \`dispatch.ts suggest learn${days === null ? "" : ` --days ${days}`} --out\`.`, "Minutes lost = minutes the node spent in error, from the run's events.", ""];
  if (!rows.length) lines.push("No known failure signatures.", "");
  for (const r of rows) {
    const lost = r.evidence.reduce((a, e) => a + e.minutes_lost, 0);
    lines.push(`## ${r.signature}`, "", `- Count: ${r.count} in ${r.runs.length} run(s), ${lost} min lost`, `- Fix: ${r.fix}`, `- Fix commit: ${r.commit ?? "open"}`, "", "| Run | Node | Minutes lost |", "| --- | --- | --- |");
    for (const e of r.evidence) lines.push(`| ${e.run} | ${e.node} | ${e.minutes_lost} |`);
    lines.push("");
  }
  return lines.join("\n");
}

function optValue(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : null;
}

export async function suggestLearn(args: string[]): Promise<number> {
  const home = orchHome();
  const daysArg = optValue(args, "--days");
  const outPath = optValue(args, "--out");
  const days = daysArg === null ? null : Number(daysArg);
  if ((days !== null && !(Number.isInteger(days) && days > 0)) || outPath === "") {
    err(`usage: ${LEARN_USAGE}\n`);
    return 2;
  }
  const rows = scanSignatures(home);
  const sugFile = join(home, "suggestions.json");
  const doc = existsSync(sugFile) ? JSON.parse(readFileSync(sugFile, "utf8")) : { suggestions: [] };
  const kept = (doc.suggestions ?? []).filter((s: any) => s.kind !== "orch-fix");
  const fixes = rows.map((r) => ({ id: `orch-fix-${r.signature}`, kind: "orch-fix", status: "pending", signature: r.signature, count: r.count, runs: r.runs, nodes: r.nodes, fix: r.fix, generated_at: nowIso() }));
  const { writeFileSync, mkdirSync } = await import("node:fs");
  writeFileSync(sugFile, JSON.stringify({ ...doc, generated_at: nowIso(), suggestions: [...kept, ...fixes] }, null, 2) + "\n");
  // --days narrows the report (and --out) to recent runs; suggestions.json always covers every run.
  const report = days === null ? rows : scanSignatures(home, Date.now() - days * 86400000);
  if (outPath !== null) {
    const target = resolve(outPath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, learningsMarkdown(report, days, nowIso()));
  }
  if (args.includes("--quiet")) return 0;
  if (args.includes("--json")) out(JSON.stringify(days === null ? fixes : report, null, 2) + "\n");
  else out(report.length ? report.map((f) => `${f.signature}: ${f.count} in ${f.runs.length} run(s) -> ${f.fix}`).join("\n") + "\n" : "no known failure signatures\n");
  if (outPath !== null) out(`wrote ${resolve(outPath)}\n`);
  return 0;
}
