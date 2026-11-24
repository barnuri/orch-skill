// unorch audit: finds what a run closed without proof, so the main session can map and finish it.
// Used by scripts/unorch.ts, which writes the result to agent-spec/unorch/<run>/gaps.md.
// Every finding names its rule, the requirement or node, and the fact that triggered it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { closureProblems } from "../skills/orch/core/runs/closure.ts";
import { REQ_LEGACY, normReq } from "../skills/orch/core/commands/req.ts";

interface Node { id: string; status?: string; label?: string; role?: string; profile?: string; error?: string; unverified?: boolean; covered_by?: string; result?: { verdict?: string; summary?: string; follow_up?: string; settled?: string; settled_follow_up?: string | null } }
interface Req { id: string; text: string; status: string; reason?: string | null; nodes: string[]; evidence: Array<{ note: string }>; implemented_by?: string[]; verifier?: string | null; forced?: string | null }

export interface Finding { rule: string; severity: "high" | "medium" | "low"; subject: string; fact: string; action: string }

/** First line of a handoff tells how it came to be. */
export function handoffKind(text: string): "own" | "commit-log" | "generated" | "settled" | "missing" {
  if (text.trim() === "") return "missing";
  if (/^# Handoff from commit log/m.test(text)) return "commit-log";
  if (/^# Generated (recovery )?handoff/m.test(text)) return "generated";
  if (/by run settle:/.test(text) && text.trim().split("\n").length <= 6) return "settled";
  return /Accepted .* by run settle:/.test(text) ? "settled" : "own";
}

const WORD = /[a-z][a-z0-9-]{3,}/g;
const STOP = new Set(["with", "that", "this", "from", "have", "will", "into", "only", "page", "when", "every", "make", "sure", "should", "does", "than", "them", "they", "their", "also", "need", "needs", "show", "shows"]);
const words = (s: string): Set<string> => new Set((s.toLowerCase().match(WORD) ?? []).filter((w) => !STOP.has(w)));

/** Share of the requirement's words that a handoff mentions. A handoff about something else scores 0. */
export function overlap(requirement: string, handoff: string): number {
  const need = words(requirement);
  if (need.size === 0) return 1;
  const have = words(handoff);
  let hit = 0;
  for (const w of need) if (have.has(w) || [...have].some((h) => h.startsWith(w.slice(0, 5)))) hit++;
  return hit / need.size;
}

export function auditRun(home: string, run: string): { findings: Finding[]; reqs: Req[]; nodes: Node[] } {
  const dir = join(home, "runs", run);
  const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { status?: string; nodes: Node[] };
  const ledgerFile = join(dir, "requirements.json");
  const rawReqs = existsSync(ledgerFile) ? (JSON.parse(readFileSync(ledgerFile, "utf8")) as { requirements: Req[] }).requirements : [];
  const out: Finding[] = [];
  const add = (f: Finding): void => void out.push(f);

  // Read through the same mapping as `req list`: the stored value is reported, the read value is judged.
  for (const r of rawReqs) {
    if (Object.hasOwn(REQ_LEGACY, r.status)) {
      add({ rule: "legacy-requirement-status", severity: "medium", subject: r.id, fact: `${r.id} is stored as "${r.status}" and is read as "${normReq(r.status)}"`, action: `restate it: dispatch.ts req status ${run} ${r.id} ${normReq(r.status)}` });
    }
  }
  const reqs = rawReqs.map((r) => ({ ...r, status: normReq(r.status) }));

  if (state.status === "done") {
    const open = closureProblems(state);
    if (open.length > 0) add({ rule: "run-closed-with-open-nodes", severity: "high", subject: run, fact: `run ${run} is done while ${open.join("; ")}`, action: `reopen it or finish the open nodes: dispatch.ts node update ${run} <node> waiting --force` });
  }

  const nodeById = new Map(state.nodes.map((n) => [n.id, n]));
  const handoff = (id: string): string => {
    const f = join(dir, "out", id, "handoff.md");
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  };

  for (const r of reqs) {
    const closed = ["done", "superseded", "waived"].includes(r.status);
    const linked = r.nodes.map((id) => nodeById.get(id)).filter((n): n is Node => n !== undefined);
    if (closed && (r.forced || /settled|takeover|settle/i.test(String(r.reason ?? "")) || r.evidence.every((e) => /settled|takeover|settle|routine evidence/i.test(e.note)))) {
      add({ rule: "closed-without-check", severity: "high", subject: r.id, fact: `${r.id} "${r.text}" is ${r.status} only because a person or \`run settle\` closed it (${String(r.forced ?? r.reason ?? "").slice(0, 100)}); no independent verifier passed it`, action: `check the work yourself, then \`req verify\` it, or reopen it: req status ${run} ${r.id} in_progress` });
    }
    if (closed && !r.verifier) add({ rule: "no-independent-verifier", severity: "medium", subject: r.id, fact: `${r.id} was closed with no verifier node`, action: `dispatch.ts req verify ${run} ${r.id}` });
    if (linked.length === 0) add({ rule: "no-linked-node", severity: "high", subject: r.id, fact: `${r.id} has no node, so nothing did or checked the work`, action: "create a node for it" });
    for (const n of linked) {
      const kind = handoffKind(handoff(n.id));
      if (closed && (kind === "commit-log" || kind === "generated" || kind === "missing")) {
        add({ rule: "evidence-is-not-the-agents-report", severity: "high", subject: `${r.id} / ${n.id}`, fact: `node ${n.id}'s handoff is a ${kind === "commit-log" ? "list of commits found after the job" : kind === "generated" ? "text generated from the transcript" : "missing file"}, not the agent's own report`, action: `read the real diff and test for ${r.id} and record evidence` });
      }
      const text = handoff(n.id);
      if (closed && kind !== "missing" && overlap(r.text, text) < 0.2) {
        add({ rule: "handoff-is-about-something-else", severity: "high", subject: `${r.id} / ${n.id}`, fact: `the handoff of ${n.id} shares ${Math.round(overlap(r.text, text) * 100)}% of the words of "${r.text}"`, action: `find where ${r.id} was actually done, or do it` });
      }
      if (n.result?.summary && /Job added commits during the run|Recovered|recovered transcript|Final transcript recovered/i.test(n.result.summary)) {
        add({ rule: "result-written-by-the-system", severity: "medium", subject: `${r.id} / ${n.id}`, fact: `node ${n.id}'s result "${n.result.summary.slice(0, 80)}" was written by orch, not by the agent (verdict ${n.result.verdict})`, action: "treat the verdict as unknown until someone verifies" });
      }
      if (n.result?.settled) add({ rule: "node-accepted-by-settle", severity: "medium", subject: `${r.id} / ${n.id}`, fact: `node ${n.id} was accepted by \`run settle\`${n.result.settled_follow_up ? `; its follow-up "${String(n.result.settled_follow_up).slice(0, 80)}" was dropped` : ""}`, action: "read its original follow-up and decide" });
      if (["stopped", "skipped", "covered", "error"].includes(String(n.status))) add({ rule: "linked-node-not-done", severity: "high", subject: `${r.id} / ${n.id}`, fact: `node ${n.id} is ${n.status}${n.covered_by ? ` (covered by ${n.covered_by})` : ""}, so ${r.id} rests on work that did not finish`, action: "find the replacement node and its result" });
    }
  }
  for (const n of state.nodes) {
    if (n.result?.settled_follow_up && String(n.result.settled_follow_up).toLowerCase() !== "none") {
      add({ rule: "follow-up-dropped", severity: "medium", subject: n.id, fact: `follow-up of ${n.id} was set to "none" by settle; it said: ${String(n.result.settled_follow_up).slice(0, 160)}`, action: "do it or write down why not" });
    }
    if (n.status === "skipped" && !reqs.some((r) => r.nodes.includes(n.id)) && n.role !== "validation") {
      add({ rule: "skipped-node-no-requirement", severity: "low", subject: n.id, fact: `${n.id} was skipped and no requirement links to it`, action: "check that its goal is covered elsewhere" });
    }
  }
  return { findings: out, reqs, nodes: state.nodes };
}

export function renderFindings(findings: Finding[]): string {
  const order = { high: 0, medium: 1, low: 2 } as const;
  const rows = [...findings].sort((a, b) => order[a.severity] - order[b.severity] || a.subject.localeCompare(b.subject));
  const lines = ["| # | severity | rule | subject | fact | action |", "|---|---|---|---|---|---|"];
  rows.forEach((f, i) => lines.push(`| F${i + 1} | ${f.severity} | ${f.rule} | ${f.subject} | ${f.fact.replace(/\|/g, "/")} | ${f.action.replace(/\|/g, "/")} |`));
  return lines.join("\n");
}
