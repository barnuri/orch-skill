// Derived quality reports: one per finished node attempt, built from data a run already holds
// (attempts, run segments, node result, hub selection, requirement verifier verdicts, handoff file).
// Pure apart from the injected handoff reader: no clock, no writes. Used by `node quality export`.
import type { QualityReport, Stage } from "./contract.ts";

export type HandoffKind = "own" | "generated" | "missing";

export interface DerivedFields {
  /** "derived" for reports built here; recorded reports (node quality append) carry "recorded". */
  source: "derived" | "recorded";
  node_status: string | null;
  role: string | null;
  profile: string | null;
  harness: string | null;
  /** The model the hub planned for the node, when the hub chose it. */
  model_hub_expected: string | null;
  attempt: { number: number; total: number; final: boolean; retries: number; replaces: string | null; covered_by: string | null; replacement_depth: number };
  duration_s: number | null;
  handoff_kind: HandoffKind | null;
  node_result: { verdict: string; summary: string | null; follow_up: string | null } | null;
  attempt_error: string | null;
  verifier: Array<{ req_id: string; verifier_node: string | null; verdict: "pass" | "fail" | "pending"; role: "implementer" | "verifier" }>;
}

export type DerivedReport = QualityReport & DerivedFields;

interface Req { id: string; status: string; nodes?: string[]; verifier?: string | null; evidence?: Array<{ note?: string }> }

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const epoch = (v: unknown): number | null => {
  const t = s(v);
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms;
};

/** Stage from the node role: validation nodes review, everything else implements. */
function stageOf(role: string | null): Stage {
  return role === "validation" || role === "review" ? "review" : "implementation";
}

/** Splits run segments over the attempts: a segment belongs to the first attempt that finished at or after its end. */
export function attemptDurations(segments: Array<Record<string, unknown>>, attemptEnds: Array<number | null>): Array<number | null> {
  const total = attemptEnds.length + 1;
  const sums: Array<number | null> = Array.from({ length: total }, () => null);
  for (const seg of segments) {
    const a = epoch(seg.start) ?? epoch(seg.dispatched);
    const b = epoch(seg.end);
    if (a === null || b === null || b < a) continue;
    let idx = attemptEnds.findIndex((e) => e !== null && b <= e);
    if (idx < 0) idx = total - 1;
    sums[idx] = (sums[idx] ?? 0) + (b - a) / 1000;
  }
  return sums.map((v) => (v === null ? null : Math.round(v)));
}

/** Verdict of a requirement's verifier: the last `verifier <node> pass|fail` evidence note, else the status. */
function verifierVerdict(r: Req): "pass" | "fail" | "pending" {
  const notes = (r.evidence ?? []).map((e) => e.note ?? "").filter((n) => /^verifier \S+ (pass|fail)\b/.test(n));
  const last = notes.at(-1);
  if (last) return /^verifier \S+ pass\b/.test(last) ? "pass" : "fail";
  return r.status === "done" && r.verifier ? "pass" : "pending";
}

function verifierLinks(nodeId: string, reqs: Req[]): DerivedFields["verifier"] {
  const out: DerivedFields["verifier"] = [];
  for (const r of reqs) {
    if (!r.verifier) continue;
    if (r.verifier === nodeId) out.push({ req_id: r.id, verifier_node: r.verifier, verdict: verifierVerdict(r), role: "verifier" });
    else if ((r.nodes ?? []).includes(nodeId)) out.push({ req_id: r.id, verifier_node: r.verifier, verdict: verifierVerdict(r), role: "implementer" });
  }
  return out;
}

const FINISHED = new Set(["done", "error", "covered", "skipped"]);

/** Whether the node's last attempt ran and ended. A skipped node counts only when it started or recorded a result. */
function finalFinished(n: Record<string, any>): boolean {
  const st = String(n.status ?? "");
  if (!FINISHED.has(st)) return false;
  if (st === "skipped") return s(n.started_at) !== null || (n.result && typeof n.result === "object");
  return true;
}

export interface DeriveInput {
  runId: string;
  nodes: Array<Record<string, any>>;
  reqs: Req[];
  /** Returns the handoff kind of the node's out dir, read when the final attempt is reported. */
  handoff: (node: Record<string, any>) => HandoffKind;
}

export function deriveReports(input: DeriveInput): DerivedReport[] {
  const out: DerivedReport[] = [];
  for (const n of input.nodes) {
    const id = String(n.id ?? "");
    if (!id) continue;
    const attempts: Array<Record<string, any>> = Array.isArray(n.attempts) ? n.attempts : [];
    const includeFinal = finalFinished(n);
    const total = attempts.length + (includeFinal ? 1 : attempts.length > 0 ? 1 : 0);
    const durations = attemptDurations(Array.isArray(n.run_segments) ? n.run_segments : [], attempts.map((a) => epoch(a.finished)));
    const role = s(n.role);
    const replaces = s(n.replaces);
    const depth = (id.match(/-r\d+/g) ?? []).length;
    const verifier = verifierLinks(id, input.reqs);
    const hubExpected = s(n.hub?.expected?.model);
    const base = (k: number, final: boolean) => ({
      source: "derived" as const,
      node_status: final ? s(n.status) : "retried",
      role,
      profile: final ? s(n.profile) : s(attempts[k]?.profile) ?? s(n.profile),
      harness: s(n.harness) ?? (final ? s(n.adapter) : s(attempts[k]?.adapter)),
      model_hub_expected: hubExpected,
      attempt: { number: k + 1, total, final, retries: attempts.length, replaces, covered_by: s(n.covered_by), replacement_depth: depth },
      verifier,
    });
    attempts.forEach((a, k) => {
      const err = s(a.error);
      out.push({
        id: `${id}#${k + 1}`,
        run_id: input.runId,
        node_id: id,
        stage: stageOf(role),
        skill_id: "orch-node",
        model: { requested: s(a.model), actual: s(a.actual_model) },
        reviewer_model: null,
        verdict: { value: "error", score: null },
        confidence: null,
        findings: [],
        timestamps: { created_at: s(a.finished) ?? "", started_at: null, finished_at: s(a.finished) },
        source_artifact: null,
        adapter: "orch-derived",
        ...base(k, false),
        duration_s: durations[k] ?? null,
        handoff_kind: err && /without handoff/.test(err) ? "missing" : null,
        node_result: null,
        attempt_error: err,
      });
    });
    if (!includeFinal) continue;
    const k = attempts.length;
    const res = n.result && typeof n.result === "object" ? n.result : null;
    const status = String(n.status);
    const verdict = s(res?.verdict) ?? (status === "error" ? "error" : status === "covered" ? "covered" : "unknown");
    const started = s(n.started_at);
    const finished = s(n.finished_at) ?? s(n.finished);
    let dur = durations[k] ?? null;
    if (dur === null && started && finished) {
      const d = ((epoch(finished) ?? 0) - (epoch(started) ?? 0)) / 1000;
      dur = d >= 0 ? Math.round(d) : null;
    }
    out.push({
      id: `${id}#${k + 1}`,
      run_id: input.runId,
      node_id: id,
      stage: stageOf(role),
      skill_id: "orch-node",
      model: { requested: s(n.requested_selector) ?? s(n.model), actual: s(n.hub?.actual?.model) ?? s(n.actual_model) ?? s(n.report?.model) },
      reviewer_model: null,
      verdict: { value: verdict, score: null },
      confidence: null,
      findings: [],
      timestamps: { created_at: finished ?? "", started_at: started, finished_at: finished },
      source_artifact: null,
      adapter: "orch-derived",
      ...base(k, true),
      duration_s: dur,
      handoff_kind: input.handoff(n),
      node_result: res ? { verdict: String(res.verdict ?? ""), summary: s(res.summary), follow_up: s(res.follow_up) } : null,
      attempt_error: s(n.error),
    });
  }
  return out;
}
