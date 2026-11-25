import type { RunNode } from "../../shared/types/run-node";

export interface CoveredTarget {
  readonly runId: string;
  readonly nodeId: string;
}

export function coveredTarget(runId: string, node: RunNode): CoveredTarget | null {
  if (node.status !== "covered" || node.covered_by == null) {
    return null;
  }
  const ref = node.covered_by.trim();
  if (ref === "") {
    return null;
  }
  const slash = ref.lastIndexOf("/");
  if (slash < 0) {
    return { runId, nodeId: ref };
  }
  return { runId: ref.slice(0, slash), nodeId: ref.slice(slash + 1) };
}

export function coveredHref(runId: string, node: RunNode): string | null {
  const target = coveredTarget(runId, node);
  if (target === null) {
    return null;
  }
  return `#/run/${encodeURIComponent(target.runId)}?node=${encodeURIComponent(target.nodeId)}`;
}

export function parseNodeParam(hash: string): string | null {
  const cut = hash.indexOf("?");
  if (cut < 0) {
    return null;
  }
  return new URLSearchParams(hash.slice(cut + 1)).get("node");
}
