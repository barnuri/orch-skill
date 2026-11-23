// llm-hub-safe export of quality reports. Deterministic: no clock, no randomness.
// Strips absolute home paths, redacts secret-shaped text and truncates long evidence before anything leaves the machine.
import type { QualityReport } from "./contract.ts";

export const EXPORT_SCHEMA = "orch.quality.v1";
const MAX_TEXT = 400;

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\b(api[_-]?key|token|secret|password)\b\s*[=:]\s*\S+/gi,
];

export function redactText(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, (m) => (m.includes("=") || m.includes(":") ? m.split(/[=:]/)[0] + "=[REDACTED]" : "[REDACTED]"));
  return out;
}

function clip(text: string, max = MAX_TEXT): string {
  const t = redactText(text);
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** Replaces the home directory prefix with `~`. Paths outside home stay as they are. */
export function scrubPath(p: string | null, home: string): string | null {
  if (p === null) return null;
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

export interface ExportedReport extends Omit<QualityReport, "source_artifact" | "findings"> {
  source_artifact: string | null;
  findings: Array<Omit<QualityReport["findings"][number], "evidence" | "title"> & { title: string; evidence: string }>;
}

export function exportReports(reports: QualityReport[], home: string): { schema: string; reports: ExportedReport[] } {
  return {
    schema: EXPORT_SCHEMA,
    reports: reports.map((r) => ({
      ...r,
      source_artifact: scrubPath(r.source_artifact, home),
      findings: r.findings.map((f) => ({ ...f, title: clip(f.title), evidence: clip(f.evidence), file: f.file === null ? null : scrubPath(f.file, home) })),
    })),
  };
}
