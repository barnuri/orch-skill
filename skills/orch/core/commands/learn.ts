// `suggest learn`: scans every run's state for known failure signatures and records each one as an
// "orch-fix" suggestion (in suggestions.json, next to the profile suggestions) with the count, the runs it
// appeared in, and the fix. Read-only on runs; apply the fix through its own command.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { out } from "../io.ts";
import { paths } from "../state/home.ts";
import { nowIso } from "../state/clock.ts";
import { orchHome } from "../state/home.ts";

export const LEARN_USAGE = "dispatch.ts suggest learn [--json]";

export interface Signature { id: string; test: (n: any, run: any) => boolean; fix: string }

// Each signature is one thing that went wrong in a real run, with the fix that prevents it.
export const SIGNATURES: Signature[] = [
  { id: "ended-early-no-handoff", test: (n) => n.error === "ended early without handoff", fix: "Node prompts must finish with a handoff and a result. The early-end retry now says: decide, wait for background work, then hand off." },
  { id: "job-killed-after-work", test: (n) => /exit=(unknown|129|130|143)/.test(String(n.error ?? "")), fix: "A job closed by SIGHUP after writing its handoff counts as done (runs.ts). Never run a background command the job cannot wait for." },
  { id: "covered-dangling", test: (n, run) => n.status === "covered" && !(run.nodes ?? []).some((m: any) => m.id === String(n.covered_by ?? "").split("/").pop()), fix: "A covered node must point to a replacement that exists. Use `node replace` once; do not remove the replacement." },
  { id: "replacement-chain", test: (n) => /-r\d+-r\d+$/.test(n.id ?? ""), fix: "Replacement chains (-r2-r2) mean a node was replaced twice. Replace only an errored node, and only once it used its attempts." },
  { id: "no-requirements", test: (n, run) => n.id === "done-gate" && n.status === "done" && !run._hasLedger, fix: "Record every user request with `req add` before the gate; verify now fails a run with no requests." },
  { id: "unknown-result", test: (n) => n.result?.verdict === "unknown", fix: "Record a result for each node (`node result`); a node with no result is unknown and must not count as done." },
];

function runsDir(home: string): string[] {
  const d = paths.runs(home);
  return existsSync(d) ? readdirSync(d) : [];
}

export function scanSignatures(home: string): { signature: string; count: number; runs: string[]; nodes: string[]; fix: string }[] {
  const found: Record<string, { count: number; runs: Set<string>; nodes: string[] }> = {};
  for (const runId of runsDir(home)) {
    const f = join(paths.runs(home), runId, "state.json");
    if (!existsSync(f)) continue;
    const run = JSON.parse(readFileSync(f, "utf8"));
    const ledger = join(paths.runs(home), runId, "requirements.json");
    run._hasLedger = existsSync(ledger) && JSON.parse(readFileSync(ledger, "utf8")).requirements?.length > 0;
    for (const n of run.nodes ?? []) {
      for (const sig of SIGNATURES) {
        if (!sig.test(n, run)) continue;
        const e = (found[sig.id] ??= { count: 0, runs: new Set(), nodes: [] });
        e.count++;
        e.runs.add(runId);
        if (e.nodes.length < 10) e.nodes.push(`${runId}/${n.id}`);
      }
    }
  }
  return SIGNATURES.filter((s) => found[s.id]).map((s) => ({ signature: s.id, count: found[s.id]!.count, runs: [...found[s.id]!.runs], nodes: found[s.id]!.nodes, fix: s.fix }));
}

export async function suggestLearn(args: string[]): Promise<number> {
  const home = orchHome();
  const rows = scanSignatures(home);
  const sugFile = join(home, "suggestions.json");
  const doc = existsSync(sugFile) ? JSON.parse(readFileSync(sugFile, "utf8")) : { suggestions: [] };
  const kept = (doc.suggestions ?? []).filter((s: any) => s.kind !== "orch-fix");
  const fixes = rows.map((r) => ({ id: `orch-fix-${r.signature}`, kind: "orch-fix", status: "pending", signature: r.signature, count: r.count, runs: r.runs, nodes: r.nodes, fix: r.fix, generated_at: nowIso() }));
  const { writeFileSync } = await import("node:fs");
  writeFileSync(sugFile, JSON.stringify({ ...doc, generated_at: nowIso(), suggestions: [...kept, ...fixes] }, null, 2) + "\n");
  if (args.includes("--quiet")) return 0;
  if (args.includes("--json")) out(JSON.stringify(fixes, null, 2) + "\n");
  else out(fixes.length ? fixes.map((f) => `${f.signature}: ${f.count} in ${f.runs.length} run(s) -> ${f.fix}`).join("\n") + "\n" : "no known failure signatures\n");
  return 0;
}
