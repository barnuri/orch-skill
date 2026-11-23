// Automatic delivery queue. When an implementation node records its result, its repo, branch, worktree,
// commits and touched files are enqueued. Completed entries of one repo are grouped when their touched files do
// not overlap. An entry that overlaps the files of the group it would join is refused (needs a human), never merged.
// State lives in <home>/delivery/queue.json, written atomically. Enqueue is idempotent by key run/node.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DeliveryMode = "direct" | "pr";
export type EntryState = "queued" | "grouped" | "refused" | "delivered";

export interface DeliveryEntry {
  key: string;
  run: string;
  node: string;
  repo: string;
  branch: string;
  worktree: string;
  commits: string[];
  touched: string[];
  state: EntryState;
  group: string | null;
  refused_reason: string | null;
  enqueued_at: string;
}

export interface DeliveryGroup {
  id: string;
  repo: string;
  mode: DeliveryMode;
  entries: string[];
  touched: string[];
}

export interface DeliveryQueue {
  version: 1;
  entries: Record<string, DeliveryEntry>;
}

export const entryKey = (run: string, node: string) => `${run}/${node}`;

export function emptyQueue(): DeliveryQueue {
  return { version: 1, entries: {} };
}

export function queuePath(home: string): string {
  return join(home, "delivery", "queue.json");
}

export function loadQueue(home: string): DeliveryQueue {
  const file = queuePath(home);
  if (!existsSync(file)) return emptyQueue();
  return JSON.parse(readFileSync(file, "utf8")) as DeliveryQueue;
}

// Atomic write: temp file then rename, so a restart never reads a half-written queue.
export function saveQueue(home: string, q: DeliveryQueue): void {
  const file = queuePath(home);
  mkdirSync(join(home, "delivery"), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(q, null, 2) + "\n");
  renameSync(tmp, file);
}

// Adds an entry. A key that already exists is returned unchanged (idempotent after a restart or a repeated result).
export function enqueue(q: DeliveryQueue, input: Omit<DeliveryEntry, "key" | "state" | "group" | "refused_reason" | "enqueued_at">, now: string): { queue: DeliveryQueue; entry: DeliveryEntry; added: boolean } {
  const key = entryKey(input.run, input.node);
  const existing = q.entries[key];
  if (existing) return { queue: q, entry: existing, added: false };
  const entry: DeliveryEntry = { ...input, key, state: "queued", group: null, refused_reason: null, enqueued_at: now };
  return { queue: { ...q, entries: { ...q.entries, [key]: entry } }, entry, added: true };
}

// Repo policy from the target repo's own instructions. A repo whose CLAUDE.md or AGENTS.md requires a PR goes
// through PRs. Otherwise a private repo (path under a `private` folder) commits to its default branch directly.
// Any other repo goes through a PR.
export function deliveryMode(repo: string, instructions: string): DeliveryMode {
  if (/pull request|\bPRs?\b (is )?required|open a PR|never commit to (the )?(default|main|master)/i.test(instructions)) return "pr";
  return /(^|\/)private(\/|$)/.test(repo) ? "direct" : "pr";
}

function overlaps(a: string[], b: Set<string>): string[] {
  return a.filter((f) => b.has(f));
}

// Rebuilds the groups from every entry, in enqueue order, one group per repo. An entry joins its repo's group when
// its touched files do not overlap the group's files. An entry that overlaps the group is refused: its shared files
// go into refused_reason and it is not merged. Rebuilding from scratch keeps the result deterministic after a restart.
export function groupQueue(q: DeliveryQueue, modeOf: (repo: string) => DeliveryMode): { queue: DeliveryQueue; groups: DeliveryGroup[] } {
  const entries = Object.values(q.entries).sort((a, b) => a.enqueued_at.localeCompare(b.enqueued_at) || a.key.localeCompare(b.key));
  const groups = new Map<string, DeliveryGroup>();
  const out: Record<string, DeliveryEntry> = { ...q.entries };

  for (const e of entries) {
    // Delivered entries and conflict refusals keep their state: a rebuild never re-queues them.
    if (e.state === "delivered" || e.refused_reason?.startsWith("conflict") === true) continue;
    const id = `${e.repo}#1`;
    const group = groups.get(e.repo);
    if (!group) {
      groups.set(e.repo, { id, repo: e.repo, mode: modeOf(e.repo), entries: [e.key], touched: [...e.touched] });
      out[e.key] = { ...e, state: "grouped", group: id, refused_reason: null };
      continue;
    }
    const shared = overlaps(e.touched, new Set(group.touched));
    if (shared.length > 0) {
      out[e.key] = { ...e, state: "refused", group: null, refused_reason: `overlap with ${id}: ${shared.join(", ")}` };
      continue;
    }
    group.entries.push(e.key);
    group.touched.push(...e.touched.filter((f) => !group.touched.includes(f)));
    out[e.key] = { ...e, state: "grouped", group: id, refused_reason: null };
  }
  return { queue: { ...q, entries: out }, groups: [...groups.values()] };
}
