// Generic quality report contract. Any skill can produce one: it names itself with `skill_id` and
// supplies raw evidence paths. Nothing here imports a skill. Pure: no I/O, no Bun APIs.

export const STAGES = ["implementation", "review", "final-review"] as const;
export const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const;
export type Stage = (typeof STAGES)[number];
export type Severity = (typeof SEVERITIES)[number];

export interface QualityFinding {
  id: string;
  severity: Severity;
  category: string;
  title: string;
  evidence: string;
  file: string | null;
  line: number | null;
  confidence: number | null;
}

export interface QualityReport {
  id: string;
  run_id: string;
  node_id: string;
  stage: Stage;
  skill_id: string;
  model: { requested: string | null; actual: string | null };
  reviewer_model: string | null;
  verdict: { value: string; score: number | null };
  confidence: number | null;
  findings: QualityFinding[];
  timestamps: { created_at: string; started_at: string | null; finished_at: string | null };
  source_artifact: string | null;
  adapter: string;
}

/** What an adapter returns: everything a report needs except the ids, the run and the clock. */
export interface QualityDraft {
  stage?: unknown;
  skill_id?: unknown;
  model?: { requested?: unknown; actual?: unknown };
  reviewer_model?: unknown;
  verdict?: { value?: unknown; score?: unknown };
  confidence?: unknown;
  findings?: unknown;
  timestamps?: { started_at?: unknown; finished_at?: unknown };
  source_artifact?: unknown;
}

export interface FinalizeCtx {
  runId: string;
  nodeId: string;
  id: string;
  now: string;
  adapter: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const score = (v: unknown, what: string): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 100) throw new Error(`${what} must be an integer 0-100 or null`);
  return v;
};

function finding(raw: unknown, i: number): QualityFinding {
  if (!raw || typeof raw !== "object") throw new Error(`finding ${i + 1}: must be an object`);
  const f = raw as Record<string, unknown>;
  const severity = str(f.severity);
  if (!severity || !(SEVERITIES as readonly string[]).includes(severity)) throw new Error(`finding ${i + 1}: severity must be one of ${SEVERITIES.join(" ")}`);
  const category = str(f.category);
  if (!category) throw new Error(`finding ${i + 1}: category is required`);
  const title = str(f.title);
  if (!title) throw new Error(`finding ${i + 1}: title is required`);
  const line = f.line ?? null;
  if (line !== null && (typeof line !== "number" || !Number.isInteger(line) || line < 1)) throw new Error(`finding ${i + 1}: line must be a positive integer or null`);
  return {
    id: `F${i + 1}`,
    severity: severity as Severity,
    category,
    title,
    evidence: typeof f.evidence === "string" ? f.evidence : "",
    file: str(f.file),
    line: line as number | null,
    confidence: score(f.confidence ?? null, `finding ${i + 1}: confidence`),
  };
}

/** Validates a draft and builds the stored report. Throws Error with a one-line message on bad input. */
export function finalizeQualityReport(draft: QualityDraft, ctx: FinalizeCtx): QualityReport {
  const stage = str(draft.stage);
  if (!stage || !(STAGES as readonly string[]).includes(stage)) throw new Error(`stage must be one of ${STAGES.join(" ")}`);
  const skill = str(draft.skill_id);
  if (!skill) throw new Error("skill_id is required");
  if (!Array.isArray(draft.findings ?? [])) throw new Error("findings must be an array");
  const findings = ((draft.findings ?? []) as unknown[]).map((f, i) => finding(f, i));
  const verdict = str(draft.verdict?.value);
  if (!verdict) throw new Error("verdict.value is required");
  return {
    id: ctx.id,
    run_id: ctx.runId,
    node_id: ctx.nodeId,
    stage: stage as Stage,
    skill_id: skill,
    model: { requested: str(draft.model?.requested), actual: str(draft.model?.actual) },
    reviewer_model: str(draft.reviewer_model),
    verdict: { value: verdict, score: score(draft.verdict?.score ?? null, "verdict.score") },
    confidence: score(draft.confidence ?? null, "confidence"),
    findings,
    timestamps: { created_at: ctx.now, started_at: str(draft.timestamps?.started_at), finished_at: str(draft.timestamps?.finished_at) },
    source_artifact: str(draft.source_artifact),
    adapter: ctx.adapter,
  };
}
