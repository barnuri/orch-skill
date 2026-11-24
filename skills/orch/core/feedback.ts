// Feedback store: one JSON file per item under <home>/feedback/<id>.json. Bun built-ins only.
// Single writer: the feedback CLI, the /api/feedback routes and the owner binder (owners.ts ownerFeedback) call these functions.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEEDBACK_KINDS, FEEDBACK_SOURCES, FEEDBACK_STATUSES,
  type FeedbackItem, type FeedbackKind, type FeedbackNote, type FeedbackSource, type FeedbackStatus,
} from "../../../src/shared/types/feedback.ts";

export type { FeedbackItem, FeedbackKind, FeedbackNote, FeedbackSource, FeedbackStatus };

export function feedbackDir(home: string): string {
  return join(home, "feedback");
}

export function isKind(v: unknown): v is FeedbackKind {
  return typeof v === "string" && (FEEDBACK_KINDS as readonly string[]).includes(v);
}
export function isStatus(v: unknown): v is FeedbackStatus {
  return typeof v === "string" && (FEEDBACK_STATUSES as readonly string[]).includes(v);
}
export function isSource(v: unknown): v is FeedbackSource {
  return typeof v === "string" && (FEEDBACK_SOURCES as readonly string[]).includes(v);
}

// yyyymmdd of an ISO timestamp, UTC.
export function dayStamp(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, "");
}

// fb-<yyyymmdd>-<n>, n = 1 + the highest n already used on that day.
export function nextFeedbackId(existingIds: string[], iso: string): string {
  const day = dayStamp(iso);
  const prefix = `fb-${day}-`;
  let max = 0;
  for (const id of existingIds) {
    if (!id.startsWith(prefix)) continue;
    const n = Number(id.slice(prefix.length));
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `${prefix}${max + 1}`;
}

export interface NewFeedbackInput {
  text: string;
  source: FeedbackSource;
  kind?: FeedbackKind;
  chat_id?: string;
  run_id?: string;
  node_id?: string;
}

export function buildFeedback(input: NewFeedbackInput, id: string, nowIso: string): FeedbackItem {
  const text = input.text.trim();
  if (!text) throw new Error("feedback text is empty");
  if (!isSource(input.source)) throw new Error(`bad source "${input.source}" (chat|cli|ui)`);
  const kind = input.kind ?? "other";
  if (!isKind(kind)) throw new Error(`bad kind "${kind}" (bug|idea|ux|other)`);
  const item: FeedbackItem = { id, text, source: input.source, kind, status: "new", created: nowIso, updated: nowIso };
  if (input.chat_id) item.chat_id = input.chat_id;
  if (input.run_id) item.run_id = input.run_id;
  if (input.node_id) item.node_id = input.node_id;
  return item;
}

export interface FeedbackPatch {
  status?: FeedbackStatus;
  result?: string;
  work_run?: string;
}

export function applyPatch(item: FeedbackItem, patch: FeedbackPatch, nowIso: string): FeedbackItem {
  const next: FeedbackItem = { ...item };
  if (patch.status !== undefined) {
    if (!isStatus(patch.status)) throw new Error(`bad status "${patch.status}" (new|queued|working|done|wontfix)`);
    next.status = patch.status;
  }
  if (patch.result !== undefined) next.result = patch.result;
  if (patch.work_run !== undefined) next.work_run = patch.work_run;
  next.updated = nowIso;
  return next;
}

export function filterFeedback(items: FeedbackItem[], f: { status?: FeedbackStatus; ids?: string[] }): FeedbackItem[] {
  return items
    .filter((i) => (f.status ? i.status === f.status : true))
    .filter((i) => (f.ids ? f.ids.includes(i.id) : true))
    .sort((a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : a.id.localeCompare(b.id)));
}

export function readFeedback(home: string): FeedbackItem[] {
  const dir = feedbackDir(home);
  if (!existsSync(dir)) return [];
  const items: FeedbackItem[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      items.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as FeedbackItem);
    } catch {
      // A corrupt file must not hide the other items or block new adds. Skip it.
    }
  }
  return items;
}

// The id is also a file name, so only the fb-yyyymmdd-n form may reach the disk.
export const FEEDBACK_ID_PATTERN = /^fb-\d{8}-\d+$/;

function assertFeedbackId(id: string): void {
  if (!FEEDBACK_ID_PATTERN.test(id)) throw new Error(`bad feedback id "${id}" (fb-yyyymmdd-n)`);
}

export function getFeedback(home: string, id: string): FeedbackItem | null {
  assertFeedbackId(id);
  const file = join(feedbackDir(home), `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as FeedbackItem;
}

// Write through a temp file and rename, so a reader never sees a half-written item.
// The tmp name is unique per process and call, so two writers never share one tmp file.
function writeItem(home: string, item: FeedbackItem): void {
  const dir = feedbackDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${item.id}.json`);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(item, null, 2) + "\n");
  renameSync(tmp, file);
}

// Lower case, whitespace collapsed, trimmed: the text key of an item with no run and no node.
export function normalizeFeedbackText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

// An item is open until it is done or wontfix.
export function isOpenFeedback(item: FeedbackItem): boolean {
  return item.status !== "done" && item.status !== "wontfix";
}

// The open item a new add merges into: the same run and node when the add names either,
// otherwise an item with no run and no node and the same normalized text. Oldest first.
export function findDuplicateFeedback(items: FeedbackItem[], input: NewFeedbackInput): FeedbackItem | null {
  const run = input.run_id || undefined;
  const node = input.node_id || undefined;
  const hasScope = run !== undefined && node !== undefined;
  const key = normalizeFeedbackText(input.text);
  const match = (item: FeedbackItem): boolean => {
    if (!isOpenFeedback(item)) return false;
    if (hasScope) return item.run_id === run && item.node_id === node;
    if (run !== undefined || node !== undefined) return false;
    return item.run_id === undefined && item.node_id === undefined && normalizeFeedbackText(item.text) === key;
  };
  return filterFeedback(items, {}).find(match) ?? null;
}

// Adds an item, or merges into an open duplicate (findDuplicateFeedback): the new text becomes a note
// on the existing item and its id is kept. `merged` tells which happened.
export function addOrMergeFeedback(home: string, input: NewFeedbackInput, nowIso: string): { item: FeedbackItem; merged: boolean } {
  const probe = buildFeedback(input, "fb-00000000-0", nowIso);
  const dup = findDuplicateFeedback(readFeedback(home), input);
  if (!dup) return { item: addFeedback(home, input, nowIso, false), merged: false };
  const next: FeedbackItem = {
    ...dup,
    notes: [...(dup.notes ?? []), { at: nowIso, text: probe.text, source: probe.source }],
    updated: nowIso,
  };
  writeItem(home, next);
  return { item: next, merged: true };
}

// Creates the file only if it does not exist (flag wx). On a clash with another writer, try the next number.
// With dedup (the default) an open duplicate gets the text as a note and is returned instead (addOrMergeFeedback).
export function addFeedback(home: string, input: NewFeedbackInput, nowIso: string, dedup = true): FeedbackItem {
  if (dedup) return addOrMergeFeedback(home, input, nowIso).item;
  const dir = feedbackDir(home);
  mkdirSync(dir, { recursive: true });
  const ids = readFeedback(home).map((i) => i.id);
  for (;;) {
    const id = nextFeedbackId(ids, nowIso);
    const item = buildFeedback(input, id, nowIso);
    try {
      writeFileSync(join(dir, `${id}.json`), JSON.stringify(item, null, 2) + "\n", { flag: "wx" });
      return item;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      ids.push(id);
    }
  }
}

export function updateFeedback(home: string, id: string, patch: FeedbackPatch, nowIso: string): FeedbackItem {
  assertFeedbackId(id);
  const cur = getFeedback(home, id);
  if (!cur) throw new Error(`no feedback ${id}`);
  const next = applyPatch(cur, patch, nowIso);
  writeItem(home, next);
  return next;
}
