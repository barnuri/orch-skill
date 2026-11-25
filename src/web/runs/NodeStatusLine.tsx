import "./runs.css";
import type { RunNode } from "../../shared/types/run-node";
import type { TimedRun } from "../../shared/node-timing";
import { paletteClass } from "../../shared/status-palette";
import { useToast } from "../components/Toast";
import { rel } from "../lib/format";
import { lastActivity, resultChip, resultLabel, ownerChip, ownerStateLabel } from "../lib/node-flags";
import { usageMetric } from "../lib/node-metrics";
import { useNodeDuration } from "./GraphSvg";

const compact = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** A long id shortened to its last characters: `…6720`. */
export function shortId(id: string, keep = 4): string {
  return id.length <= keep + 1 ? id : `…${id.slice(-keep)}`;
}

export interface Segment {
  key: string;
  text: string;
  tone: string;
  title?: string;
  role?: "img";
  /** The full value copied on click. */
  copy?: string;
}

/** The segments of the node status line, in display order. Pure. */
export function statusSegments(node: RunNode, maxAttempts: number, durationText: string): Segment[] {
  const out: Segment[] = [];
  out.push({ key: "state", text: node.status, tone: `st-${node.status} node-statusline-state` });
  const verdict = resultChip(node);
  if (verdict !== null) {
    out.push({ key: "result", text: verdict.verdict, tone: `rs-${verdict.verdict} node-statusline-result result-${verdict.verdict} ${paletteClass(verdict.verdict)}`, role: "img", title: resultLabel(verdict.verdict) });
  }
  out.push({ key: "profile", text: node.profile ?? "no profile", tone: "t-profile" });
  const model = node.actual_model ?? node.model_id ?? node.model ?? "no model";
  out.push({ key: "model", text: model, tone: "t-model", title: model });
  out.push({ key: "attempt", text: `attempt ${(node.attempts?.length ?? 0) + 1}/${maxAttempts}`, tone: "t-muted" });
  const owner = ownerChip(node);
  const last = lastActivity(node);
  const ownerText = owner?.text ?? ownerStateLabel(node);
  out.push({ key: "owner", text: last === null ? ownerText : `${ownerText} · ${rel(last)}`, tone: `o-${owner?.cls ?? "none"}`, title: node.owner_reason ?? owner?.title });
  if (durationText !== "" && durationText !== "—") {
    out.push({ key: "duration", text: durationText, tone: "t-muted" });
  }
  const cost = node.cost;
  if (cost !== undefined && cost !== null) {
    out.push({
      key: "tokens",
      text: `${compact(cost.input_tokens)} in · ${compact(cost.output_tokens)} out · ${compact(cost.cache_read_tokens)} cache read · ${compact(cost.cache_creation_tokens)} written`,
      tone: "t-tokens",
    });
    out.push({ key: "cost", text: cost.usd > 0 ? `$${cost.usd.toFixed(2)}` : "$0.00", tone: "t-cost", title: `${cost.cost_basis} price` });
  } else {
    const usage = usageMetric(node);
    if (usage.present) {
      out.push({ key: "tokens", text: usage.text, tone: "t-tokens", title: usage.title });
    }
  }
  if (node.job_id) {
    out.push({ key: "job", text: `job ${shortId(node.job_id)}`, tone: "t-id", title: node.job_id, copy: node.job_id });
  }
  if (node.session) {
    out.push({ key: "session", text: `session ${shortId(node.session)}`, tone: "t-id", title: node.session, copy: node.session });
  }
  return out;
}

/** The colored segment rows under the composer. A long id shows its tail, the full value is the tooltip and a click copies it. */
export function NodeStatusLine({ node, run, maxAttempts, segments: given }: { node: RunNode; run: TimedRun | null | undefined; maxAttempts: number; segments?: Segment[] }) {
  const toast = useToast();
  const duration = useNodeDuration(node, run);
  const segments = given ?? statusSegments(node, maxAttempts, duration.present ? duration.text : "");
  return (
    <footer className="node-statusline" aria-label={given === undefined ? "Node status line" : "Orchestrator status line"}>
      {segments.map((seg) =>
        seg.copy === undefined ? (
          <span key={seg.key} className={`sl-chip ${seg.tone} ${seg.key === "state" && given === undefined ? paletteClass(node.status) : ""}`.trim()} data-seg={seg.key} title={seg.title} role={seg.role} aria-label={seg.role === "img" ? seg.title : undefined}>
            {seg.text}
          </span>
        ) : (
          <button
            key={seg.key}
            type="button"
            className={`sl-chip is-copy ${seg.tone}`}
            data-seg={seg.key}
            title={`${seg.copy} (click to copy)`}
            onClick={() => {
              void navigator.clipboard?.writeText(seg.copy ?? "").then(
                () => toast("ok", `${seg.key} id copied`),
                () => toast("error", "Could not copy"),
              );
            }}
          >
            {seg.text}
          </button>
        ),
      )}
    </footer>
  );
}
