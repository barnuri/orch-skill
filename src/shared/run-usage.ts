import type { RunNode } from "./types/run-node";

/** What a node or run used. A field is null when nothing reported it: never estimated. */
export interface UsageTotal {
  usd: number | null;
  tokens: number | null;
}

type UsageSource = "cost" | "report" | "session";

export interface NodeUsageRead extends UsageTotal {
  source: UsageSource | null;
}

function positive(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function sumKnown(values: readonly (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length === 0 ? null : known.reduce((sum, value) => sum + value, 0);
}

/**
 * The node's usage: the harness-reported `cost` when it carries a figure, else what the
 * coordinator reported with `node report`, else the bound opencode session's totals
 * (`session_stats`): one source per node, so a run total never counts the same spend twice. Zero from a harness is "reported nothing"; zero from
 * `node report` is a real figure.
 */
export function nodeUsage(node: RunNode): NodeUsageRead {
  const cost = node.cost;
  if (cost !== undefined && cost !== null) {
    const usd = positive(cost.usd);
    const tokens = positive(
      (cost.input_tokens ?? 0) + (cost.output_tokens ?? 0) + (cost.cache_read_tokens ?? 0) + (cost.cache_creation_tokens ?? 0),
    );
    if (usd !== null || tokens !== null) {
      return { usd, tokens, source: "cost" };
    }
  }
  const report = node.report;
  if (report !== undefined && report !== null) {
    const usd = sumKnown([report.usd]);
    const tokens = sumKnown([report.input_tokens, report.output_tokens, report.cache_read_tokens]);
    if (usd !== null || tokens !== null) {
      return { usd, tokens, source: "report" };
    }
  }
  const stats = node.session_stats;
  if (stats !== undefined && stats !== null) {
    const usd = positive(stats.cost);
    const t = stats.tokens;
    const tokens = positive((t?.input ?? 0) + (t?.output ?? 0) + (t?.cache_read ?? 0) + (t?.cache_write ?? 0));
    if (usd !== null || tokens !== null) {
      return { usd, tokens, source: "session" };
    }
  }
  return { usd: null, tokens: null, source: null };
}

export interface RunUsage extends UsageTotal {
  /** Nodes that reported any usage. */
  reporting: number;
  total: number;
}

export function runUsage(nodes: readonly RunNode[]): RunUsage {
  const reads = nodes.map(nodeUsage);
  return {
    usd: sumKnown(reads.map((read) => read.usd)),
    tokens: sumKnown(reads.map((read) => read.tokens)),
    reporting: reads.filter((read) => read.usd !== null || read.tokens !== null).length,
    total: nodes.length,
  };
}
