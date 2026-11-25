// Per-node bulk fields kept out of runs/<id>/state.json: selection_history, log_tail and attempts.
// They live in runs/<id>/nodes/<node>/{selections,log_tail,attempts}.jsonl. state.json keeps a short summary per node:
// `selection_count`, `last_selection`, `attempt_count`. Node-only imports (fs, path): the dashboard server reads them too.
//
// loadRun attaches lazy accessors, so a command that never touches a field never reads its file. saveRun calls
// `splitRunForSave`: untouched fields cost nothing, changed fields are appended (selections, attempts) or replaced by a
// new last record (log_tail). A run that still has the fields inline in state.json is migrated lazily, on its next save.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BULK_FIELDS = ["selection_history", "log_tail", "attempts"] as const;
type BulkField = (typeof BULK_FIELDS)[number];

export const SELECTION_FILE_MAX = 500;
const FILE_OF: Record<BulkField, string> = { selection_history: "selections.jsonl", log_tail: "log_tail.jsonl", attempts: "attempts.jsonl" };
/** A log_tail file past this size is rewritten with its last record only. */
const LOG_TAIL_COMPACT_BYTES = 256 * 1024;

type Json = any;

export const nodeFilesDir = (home: string, runId: string, nodeId: string): string => join(home, "runs", runId, "nodes", nodeId);
const fileOf = (home: string, runId: string, nodeId: string, field: BulkField): string => join(nodeFilesDir(home, runId, nodeId), FILE_OF[field]);

function readLines(file: string): Json[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: Json[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch { /* a torn last line is skipped */ }
  }
  return out;
}

const isReset = (r: Json): boolean => r !== null && typeof r === "object" && !Array.isArray(r) && r._reset === 1;

/** Reads one field of one node from its file. `fallback` is returned when the node has no file. */
export function readNodeField(home: string, runId: string, nodeId: string, field: BulkField): Json {
  const file = fileOf(home, runId, nodeId, field);
  const lines = readLines(file);
  if (field === "log_tail") {
    const last = lines[lines.length - 1];
    return Array.isArray(last?.lines) ? last.lines : [];
  }
  let items: Json[] = [];
  for (const r of lines) {
    if (isReset(r)) items = [];
    else items.push(r);
  }
  return field === "selection_history" && items.length > SELECTION_FILE_MAX ? items.slice(items.length - SELECTION_FILE_MAX) : items;
}

const seqOf = (e: Json): number => (typeof e?.seq === "number" ? e.seq : Number(e?.seq) || 0);
const newestSelection = (items: Json[]): Json => (items.length === 0 ? null : items.reduce((best, e) => (seqOf(e) >= seqOf(best) ? e : best)));

/** The node as the run page shows it: newest selection event only, attempts without their log tails, no log tail. */
export function slimNodeFromSummary(home: string, runId: string, node: Record<string, Json>): Record<string, Json> {
  if (!hasSummary(node)) return node;
  const out: Record<string, Json> = { ...node, log_tail: [] };
  out.selection_history = node.last_selection ? [node.last_selection] : [];
  const count = Number(node.attempt_count ?? 0);
  out.attempts = count > 0 ? (readNodeField(home, runId, String(node.id), "attempts") as Json[]).map((a) => (a && a.log_tail !== undefined ? { ...a, log_tail: [] } : a)) : [];
  delete out.selection_count; delete out.last_selection; delete out.attempt_count;
  return out;
}

/** The node with all three fields filled from its files (a summary-only node); a legacy node comes back as it is. */
export function fullNodeFromSummary(home: string, runId: string, node: Record<string, Json>): Record<string, Json> {
  if (!hasSummary(node)) return node;
  const out: Record<string, Json> = { ...node };
  for (const f of BULK_FIELDS) out[f] = readNodeField(home, runId, String(node.id), f);
  delete out.selection_count; delete out.last_selection; delete out.attempt_count;
  return out;
}

const hasSummary = (n: Record<string, Json>): boolean => "attempt_count" in n || "selection_count" in n;

// ---- lazy load ---------------------------------------------------------------------------------------

interface Lazy {
  home: string;
  runId: string;
  nodeId: string;
  /** field -> persisted JSON at hydrate time (the baseline to diff against). A field with no entry is not hydrated. */
  baseline: Map<BulkField, string>;
  loaded: Map<BulkField, Json>;
  /** Fields assigned through the setter: always saved. */
  assigned: Set<BulkField>;
  /** Set for a node from a legacy state.json: its inline fields are migrated by overwrite on the next save. */
  legacy: Set<BulkField>;
}
const LAZY = new WeakMap<object, Lazy>();

/** Replaces the missing bulk fields of every node with lazy accessors. Call right after parsing state.json. */
export function attachLazyFields(home: string, runId: string, run: { nodes?: Array<Record<string, Json>> }): void {
  for (const node of run.nodes ?? []) {
    if (!node || typeof node !== "object" || typeof node.id !== "string") continue;
    const lazy: Lazy = { home, runId, nodeId: node.id, baseline: new Map(), loaded: new Map(), assigned: new Set(), legacy: new Set() };
    LAZY.set(node, lazy);
    for (const f of BULK_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(node, f)) {
        lazy.legacy.add(f); // inline in state.json: stays a plain property until saved
        continue;
      }
      if (!hasSummary(node)) continue; // a node made in memory without fields: plain missing property
      Object.defineProperty(node, f, {
        enumerable: true,
        configurable: true,
        get() {
          if (!lazy.loaded.has(f)) {
            const v = readNodeField(lazy.home, lazy.runId, lazy.nodeId, f);
            lazy.loaded.set(f, v);
            lazy.baseline.set(f, JSON.stringify(v));
          }
          return lazy.loaded.get(f);
        },
        set(v: Json) {
          if (!lazy.loaded.has(f)) lazy.baseline.set(f, JSON.stringify(readNodeField(lazy.home, lazy.runId, lazy.nodeId, f)));
          lazy.loaded.set(f, v);
          lazy.assigned.add(f);
        },
      });
    }
    if (hasSummary(node)) {
      // The summary props are only read through the accessors; hide them from spreads and clones of the hydrated node.
      for (const k of ["selection_count", "last_selection", "attempt_count"]) {
        if (k in node) Object.defineProperty(node, k, { enumerable: false, writable: true, configurable: true, value: node[k] });
      }
    }
  }
}

// ---- save --------------------------------------------------------------------------------------------

const keyOf = (e: Json): string => (e && e.seq !== undefined && e.seq !== null ? `s${e.seq}` : JSON.stringify(e));

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp.${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function persist(home: string, runId: string, nodeId: string, field: BulkField, value: Json, baselineJson: string | null, overwrite: boolean): void {
  const file = fileOf(home, runId, nodeId, field);
  const empty = !Array.isArray(value) || value.length === 0;
  if (!existsSync(file) && empty) return;
  mkdirSync(nodeFilesDir(home, runId, nodeId), { recursive: true });
  if (field === "log_tail") {
    const lines = Array.isArray(value) ? value : [];
    if (!overwrite && baselineJson === JSON.stringify(lines)) return;
    const rec = JSON.stringify({ t: new Date().toISOString(), lines }) + "\n";
    const big = existsSync(file) && statSync(file).size > LOG_TAIL_COMPACT_BYTES;
    if (overwrite || big) writeAtomic(file, rec);
    else appendFileSync(file, rec);
    return;
  }
  const items: Json[] = Array.isArray(value) ? value : [];
  if (overwrite) {
    writeAtomic(file, items.map((e) => JSON.stringify(e) + "\n").join(""));
    return;
  }
  const base: Json[] = baselineJson === null ? [] : JSON.parse(baselineJson);
  if (JSON.stringify(items) === baselineJson) return;
  if (items.length === 0) {
    appendFileSync(file, JSON.stringify({ _reset: 1 }) + "\n");
    return;
  }
  const known = new Set(base.map(keyOf));
  const fresh = items.filter((e) => !known.has(keyOf(e)));
  // attempts are never edited in place: a changed prefix means the array was rebuilt, so rewrite the file.
  const prefixOk = field !== "attempts" || base.every((e, i) => JSON.stringify(e) === JSON.stringify(items[i]));
  if (!prefixOk) {
    writeAtomic(file, items.map((e) => JSON.stringify(e) + "\n").join(""));
    return;
  }
  if (field === "attempts") {
    const extra = items.slice(base.length);
    if (extra.length > 0) appendFileSync(file, extra.map((e) => JSON.stringify(e) + "\n").join(""));
    return;
  }
  if (fresh.length > 0) appendFileSync(file, fresh.map((e) => JSON.stringify(e) + "\n").join(""));
}

/**
 * Writes the node files for every touched bulk field and returns the run document to put in state.json:
 * a shallow copy where each node has the summary instead of the three fields. The input run is not changed.
 */
export function splitRunForSave<T extends { nodes?: Array<Record<string, Json>> }>(home: string, runId: string, run: T): T {
  if (!Array.isArray(run.nodes)) return run;
  const nodes = run.nodes.map((node) => {
    if (!node || typeof node !== "object" || typeof node.id !== "string") return node;
    let lazy = LAZY.get(node);
    // A node moved from another run (merge) or never loaded: read it fully first, then treat every field as legacy.
    if (lazy && (lazy.runId !== runId || lazy.home !== home)) {
      const detached: Json = {};
      for (const f of BULK_FIELDS) detached[f] = node[f];
      const copy: Record<string, Json> = { ...node, ...detached };
      lazy = { home, runId, nodeId: node.id, baseline: new Map(), loaded: new Map(), assigned: new Set(), legacy: new Set(BULK_FIELDS) };
      return splitNode(home, runId, copy, lazy);
    }
    return splitNode(home, runId, node, lazy ?? { home, runId, nodeId: node.id, baseline: new Map(), loaded: new Map(), assigned: new Set(), legacy: new Set(BULK_FIELDS) });
  });
  return { ...run, nodes } as T;
}

function splitNode(home: string, runId: string, node: Record<string, Json>, lazy: Lazy): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const k of Object.keys(node)) if (!(BULK_FIELDS as readonly string[]).includes(k)) out[k] = node[k];
  // Summary props carried from the load (non-enumerable, so Object.keys skipped them).
  for (const k of ["selection_count", "last_selection", "attempt_count"]) if (k in node) out[k] = node[k];
  for (const f of BULK_FIELDS) {
    // A plain data property set on a node that had no file and no accessor (e.g. the first archived attempt of a
    // node loaded without attempts) is new data: write it, or it is lost on save.
    const desc = Object.getOwnPropertyDescriptor(node, f);
    const plainNew = !lazy.legacy.has(f) && !lazy.loaded.has(f) && desc !== undefined && "value" in desc;
    const touched = lazy.legacy.has(f) || plainNew ? Object.prototype.hasOwnProperty.call(node, f) : lazy.loaded.has(f);
    if (!touched) continue;
    const value: Json = node[f] ?? [];
    const overwrite = lazy.legacy.has(f) || plainNew;
    persist(home, runId, lazy.nodeId, f, value, lazy.baseline.get(f) ?? null, overwrite);
    if (f === "selection_history" && Array.isArray(value)) {
      out.selection_count = value.length;
      out.last_selection = newestSelection(value);
    }
    if (f === "attempts" && Array.isArray(value)) out.attempt_count = value.length;
  }
  // Never-touched legacy-free nodes with no summary: attempts and selections are empty.
  if (!("attempt_count" in out)) out.attempt_count = 0;
  if (!("selection_count" in out)) { out.selection_count = 0; out.last_selection = null; }
  return out;
}

/** A deep copy for a dry run: the lazy fields are not read (a node from a files-based run gets empty ones). */
export function cloneRunForDryRun<T extends { nodes?: Array<Record<string, Json>> }>(run: T): T {
  if (!Array.isArray(run.nodes)) return structuredClone(run);
  const nodes = run.nodes.map((node) => {
    if (!node || typeof node !== "object") return node;
    const copy: Record<string, Json> = {};
    for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(node))) {
      if ("value" in d) copy[k] = d.value;
    }
    if (hasSummary(node)) for (const f of BULK_FIELDS) if (!(f in copy)) copy[f] = [];
    return copy;
  });
  return structuredClone({ ...run, nodes });
}

/** The node with each bulk field taken from its file when the file exists (a legacy node keeps its inline value). */
export function nodeFromFiles(home: string, runId: string, node: Record<string, Json>): Record<string, Json> {
  const out: Record<string, Json> = { ...node };
  for (const f of BULK_FIELDS) if (existsSync(fileOf(home, runId, String(node.id), f))) out[f] = readNodeField(home, runId, String(node.id), f);
  return out;
}
