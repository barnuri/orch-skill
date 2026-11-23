// Adapters turn an artifact's text into a QualityDraft. The contract never depends on an adapter:
// a report with no adapter still needs only the generic fields. Raw artifacts stay on disk as evidence.
import type { QualityDraft } from "./contract.ts";

export type Adapter = (text: string) => QualityDraft;

/** `generic`: the artifact is JSON already shaped like a QualityDraft. */
export const parseGeneric: Adapter = (text) => {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error("generic adapter: input is not valid JSON");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("generic adapter: input must be a JSON object");
  return v as QualityDraft;
};

const LINE_RE = /^\s*\[(CR-\d+)\]\s*\[([^\]]+)\]\s*(.*)$/;
const CONFIDENCE_RE = /\(confidence\s+(\d{1,3})\)/i;
const PRIORITY_RE = /\bP([1-3])\b/;
const PRIORITY_SEVERITY: Record<string, string> = { "1": "high", "2": "medium", "3": "low" };

/**
 * `cr-markdown`: maps the /cr output lines `[CR-N] [file:line] (confidence NN) Description` to findings.
 * Priority P1/P2/P3 maps to high/medium/low; a line without a priority is medium. The verdict is
 * `satisfied` when the output carries `REVIEW SATISFIED`, otherwise `open-findings` or `no-findings`.
 * The score is null: the /cr markdown carries no score. Stage and skill come from the CLI flags.
 */
export const parseCrMarkdown: Adapter = (text) => {
  const findings: Array<Record<string, unknown>> = [];
  for (const raw of text.split("\n")) {
    const m = LINE_RE.exec(raw);
    if (!m) continue;
    const [, , loc = "", rest = ""] = m;
    const [file = "", lineText = ""] = loc.split(":");
    const conf = CONFIDENCE_RE.exec(rest);
    const prio = PRIORITY_RE.exec(rest);
    const body = rest.replace(CONFIDENCE_RE, "").replace(/\bP[1-3]\b\s*/, "").trim();
    const sep = body.indexOf(" — ");
    const title = (sep >= 0 ? body.slice(0, sep) : body).trim();
    const evidence = sep >= 0 ? body.slice(sep + 3).trim() : "";
    const line = /^\d+$/.test(lineText) ? Number(lineText) : null;
    findings.push({
      severity: PRIORITY_SEVERITY[prio?.[1] ?? ""] ?? "medium",
      category: "review",
      title: title || "(untitled)",
      evidence,
      file: file.trim() || null,
      line: line && line > 0 ? line : null,
      confidence: conf ? Number(conf[1]) : null,
    });
  }
  const satisfied = /REVIEW SATISFIED/.test(text);
  const value = satisfied ? "satisfied" : findings.length > 0 ? "open-findings" : "no-findings";
  return { skill_id: "cr", verdict: { value, score: null }, findings };
};

export const ADAPTERS: Record<string, Adapter> = {
  generic: parseGeneric,
  "cr-markdown": parseCrMarkdown,
};

export function adapterNames(): string[] {
  return Object.keys(ADAPTERS);
}
