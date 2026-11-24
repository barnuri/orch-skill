import type { RunNode } from "../../shared/types/run-node";
import { handoffText, holdReason, needsUserReason, nodeFlags, resultChip } from "./node-flags";

export interface NodeWarning {
  /** Stable key, also the CSS tone: `warn` (amber), `error` (red) or `info`. */
  code: "unowned" | "stalled" | "unverified" | "no-handoff" | "result" | "needs-user" | "held" | "error";
  tone: "warn" | "error" | "info";
  text: string;
}

/** One line per condition that applies to the node; empty when the node is healthy. Pure. */
export function nodeWarnings(node: RunNode): NodeWarning[] {
  const out: NodeWarning[] = [];
  const flags = nodeFlags(node);
  if (flags.unowned) {
    out.push({ code: "unowned", tone: "warn", text: "Unowned: marked running, but no owner or job is recorded." });
  }
  if (flags.stale) {
    out.push({ code: "stalled", tone: "warn", text: "Stalled: no activity for a while." });
  }
  if (node.status === "done" && node.unverified === true) {
    out.push({ code: "unverified", tone: "warn", text: "Unverified: done without a verifier or handoff." });
  }
  if (node.status === "done" && handoffText(node)?.missing === true) {
    out.push({ code: "no-handoff", tone: "warn", text: "No handoff: handoff.md is missing or empty." });
  }
  const result = resultChip(node);
  if (result !== null && result.verdict !== "full") {
    const why = result.summary === "" ? "" : `: ${result.summary}`;
    out.push({ code: "result", tone: result.verdict === "blocked" ? "error" : "warn", text: `Result ${result.verdict}${why}` });
  }
  const user = needsUserReason(node);
  if (user !== null) {
    out.push({ code: "needs-user", tone: "warn", text: `Needs user: ${user}` });
  }
  const hold = holdReason(node);
  if (hold !== null) {
    out.push({ code: "held", tone: "info", text: `Held: ${hold}` });
  }
  if (node.status === "error" || (node.error !== null && node.error !== undefined && node.error !== "")) {
    out.push({ code: "error", tone: "error", text: `Error: ${node.error ?? "no error text recorded"}` });
  }
  return out;
}
