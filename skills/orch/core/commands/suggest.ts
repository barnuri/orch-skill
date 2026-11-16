// Suggestions and the learning loop: suggest scan|list|apply|dismiss, and `sync`.
import { existsSync, readdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { env, err, home as ioHome, out } from "../io.ts";
import { nowIso } from "../state/clock.ts";
import { modelIdResolve, modelSlugResolve, type Catalog } from "../adapters/routing.ts";
import { ensureHome, serveDiagnose, serveRecover, VALID_OUTCOMES } from "./serve.ts";
import { quietStderr } from "../io.ts";

export const SCAN_USAGE = "dispatch.sh suggest scan";
export const LIST_USAGE = "dispatch.sh suggest list [--pending]";
export const APPLY_USAGE = "dispatch.sh suggest apply <id> | apply --all | apply --id ID [--id ID...] [--json]";
export const DISMISS_USAGE = "dispatch.sh suggest dismiss <id>";
export const SYNC_USAGE = "dispatch.sh sync [--no-serve]";
export const MEMORY_ADD_USAGE = 'dispatch.sh memory add --profile P --outcome success|failure|partial [--kind K] [--note "…"]';

type Sug = Record<string, any>;
type SugFile = { generated_at?: string; suggestions: Sug[] };

const sugFile = (home: string) => join(home, "suggestions.json");
const readJsonFile = (f: string): any => JSON.parse(readFileSync(f, "utf8"));
function writeAtomic(f: string, value: unknown): void {
  const tmp = `${f}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, f);
}

function readSug(home: string): SugFile {
  return readJsonFile(sugFile(home));
}

// jq `.[k] // d`: null and false fall back.
function learningGet(home: string, key: string, dflt: string): string {
  try {
    const v = readJsonFile(join(home, "profiles.json")).settings?.[`learning.${key}`];
    return v === undefined || v === null || v === false ? dflt : String(v);
  } catch {
    return dflt;
  }
}

// Seeds the file, repairs a missing `.suggestions`, and gives duplicated ids a suffix.
function suggestEnsure(home: string): boolean {
  const f = sugFile(home);
  let data: any = null;
  try {
    data = readJsonFile(f);
  } catch {}
  if (!data || !data.suggestions) {
    data = { generated_at: nowIso(), suggestions: [] };
    writeAtomic(f, data);
    return true;
  }
  const ids = data.suggestions.map((s: Sug) => s.id);
  if (new Set(ids).size !== ids.length) {
    data.suggestions = data.suggestions.map((s: Sug, i: number) =>
      ids.slice(0, i).includes(s.id) ? { ...s, id: `${s.id}-${i}` } : s,
    );
    writeAtomic(f, data);
  }
  return true;
}

function suggestExpireStale(home: string): void {
  let ttl = Number(learningGet(home, "dismiss_ttl_days", "30"));
  if (!/^\d+$/.test(String(ttl)) || Number.isNaN(ttl)) ttl = 30;
  const nowEpoch = Math.floor(Date.now() / 1000);
  const data = readSug(home);
  let changed = false;
  for (const s of data.suggestions) {
    if (s.status !== "pending") continue;
    const t = Date.parse(s.created);
    if (Number.isNaN(t)) continue;
    if (nowEpoch - Math.floor(t / 1000) >= ttl * 86400) {
      s.status = "expired";
      changed = true;
    }
  }
  if (changed) writeAtomic(sugFile(home), data);
}

const join2 = (parts: Array<string | null>) => parts.filter((p) => p !== null && p !== "").join("; ");

export function profileDescription(p: any): string {
  return join2([
    `${p.harness || "agent"} profile`,
    p.model ? `model ${p.model}` : null,
    p.cost ? `${p.cost} tier` : null,
    p.quality ? `${p.quality} quality` : null,
    (p.strengths ?? []).length > 0 ? `strengths: ${p.strengths.join(", ")}` : null,
  ]);
}

export function modelDescription(id: string, m: any): string {
  return join2([
    `${m.slug || id} on ${(m.harnesses ?? []).join("/")}`,
    m.cost ? `${m.cost} cost` : null,
    m.quality ? `${m.quality} quality` : null,
    m.speed ? `${m.speed} speed` : null,
  ]);
}

const newId = () => `sug-${Math.random().toString(16).slice(2, 10).padEnd(8, "0")}`;

function upsert(data: SugFile, c: Sug): void {
  const fp = c.fingerprint;
  const list = data.suggestions;
  if (list.some((s) => s.fingerprint === fp && s.status === "pending")) {
    data.suggestions = list.map((s) => (s.fingerprint === fp && s.status === "pending" ? { ...c, id: s.id } : s));
  } else if (list.some((s) => s.fingerprint === fp && (s.status === "dismissed" || s.status === "expired"))) {
    return;
  } else {
    const id = newId();
    const have = list.map((s) => s.id);
    list.push({ ...c, id: have.includes(id) ? `${id}-${have.length}` : id });
  }
}

function resolveModel(pr: any, name: string): string {
  const prof = pr.profiles?.[name];
  if (!prof || !prof.model) return "";
  if (pr.models?.[prof.model]) return prof.model;
  const hit = Object.entries(pr.models ?? {}).find(
    ([, m]: [string, any]) => m.slug === prof.model && (m.harnesses ?? []).includes(prof.harness),
  );
  return hit ? hit[0] : "";
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function readRuns(home: string): Array<{ rid: string; s: any }> {
  const dir = join(home, "runs");
  if (!existsSync(dir)) return [];
  const rows: Array<{ rid: string; s: any }> = [];
  for (const rid of readdirSync(dir).sort()) {
    try {
      rows.push({ rid, s: readJsonFile(join(dir, rid, "state.json")) });
    } catch {}
  }
  return rows;
}

export function suggestScan(home: string, quiet = false): boolean {
  suggestEnsure(home);
  suggestExpireStale(home);
  const ts = nowIso();
  const pr = readJsonFile(join(home, "profiles.json"));
  let mem: any[] = [];
  try {
    const m = readJsonFile(join(home, "memory.json"));
    if (Array.isArray(m)) mem = m;
  } catch {}
  const data = readSug(home);
  const runs = readRuns(home).filter(({ s }) => (s.status === "done" || s.status === "error") && (s.finished ?? "") !== "");
  const cands: Sug[] = [];
  for (const [name, p] of Object.entries<any>(pr.profiles ?? {})) {
    if ((p.description ?? "") !== "") continue;
    const text = profileDescription(p);
    if (!text) continue;
    cands.push({
      status: "pending", created: ts, confidence: "low", kind: "profile_description",
      title: `Auto description for ${name}`,
      reason: "Empty profile description — apply to seed routing metadata.",
      evidence: [{ type: "profile", id: name }],
      action: { type: "profile_description", profile: name, description: text },
      fingerprint: `profile_description:${name}`,
    });
  }
  for (const [id, m] of Object.entries<any>(pr.models ?? {})) {
    if ((m.description ?? "") !== "") continue;
    const text = modelDescription(id, m);
    if (!text) continue;
    cands.push({
      status: "pending", created: ts, confidence: "low", kind: "model_description",
      title: `Auto description for model ${id}`,
      reason: "Empty model description — apply to seed the catalog.",
      evidence: [{ type: "model", id }],
      action: { type: "model_description", model_id: id, description: text },
      fingerprint: `model_description:${id}`,
    });
  }
  for (const r of runs) {
    for (const n of r.s.nodes ?? []) {
      if (!(n.id ?? "") || !(n.status === "done" || n.status === "error") || !(n.profile ?? "")) continue;
      const profile = n.profile;
      const kind = Array.from(asciiLower(n.label ?? "")).slice(0, 32).join("");
      if (mem.some((m) => m.profile === profile && (m.task_kind ?? "") === kind && m.outcome === "success")) continue;
      cands.push({
        status: "pending", created: ts, confidence: "medium", kind: "memory_record",
        title: `Record memory: ${profile} / ${kind}`,
        reason: "Finished node has no matching memory row for this kind.",
        evidence: [{ type: "run", id: r.rid, node: n.id }],
        action: {
          type: "memory_record",
          memory: {
            profile, outcome: n.status === "done" ? "success" : "failure", task_kind: kind,
            note: `from run ${r.rid} node ${n.id}`, model_id: resolveModel(pr, profile),
          },
        },
        fingerprint: `memory_record:${profile}:${kind}`,
      });
    }
  }
  for (const c of cands) upsert(data, c);
  data.generated_at = ts;
  writeAtomic(sugFile(home), data);
  if (!quiet) out("scanned\n");
  return true;
}

export function memoryAdd(home: string, a: { profile: string; outcome: string; kind: string; note: string; modelId: string }, report: (s: string) => void = err): number {
  const cat: Catalog = readJsonFile(join(home, "profiles.json"));
  if (!a.profile || !a.outcome) {
    report(`usage: ${MEMORY_ADD_USAGE}\n`);
    return 2;
  }
  if (!VALID_OUTCOMES.split(" ").includes(a.outcome)) {
    report(`memory add: outcome must be one of: ${VALID_OUTCOMES}\n`);
    return 2;
  }
  const prof = cat.profiles?.[a.profile];
  if (!prof) {
    report(`profile ${a.profile}: unknown profile. Available: ${Object.keys(cat.profiles ?? {}).sort().join(", ")}\n`);
    return 2;
  }
  let modelId = a.modelId || modelIdResolve(cat, a.profile) || "";
  let model: string;
  if (modelId) model = modelSlugResolve(cat, a.profile, modelId) ?? "";
  else {
    model = prof.model ?? "";
    modelId = "";
  }
  const file = join(home, "memory.json");
  let rows: any[];
  try {
    rows = readJsonFile(file);
  } catch {
    report(`memory add: could not update ${file}\n`);
    return 1;
  }
  rows.push({
    ts: nowIso(), task_kind: a.kind, profile: a.profile, harness: prof.harness ?? "", model,
    model_id: modelId === "" ? null : modelId, outcome: a.outcome, note: a.note,
  });
  writeAtomic(file, rows);
  return 0;
}

const isAutoKind = (k: string) => ["memory_record", "profile_description", "model_description"].includes(k);

function profilesCommit(home: string, cat: any): void {
  const f = join(home, "profiles.json");
  const next = JSON.stringify(cat, null, 2) + "\n";
  if (readFileSync(f, "utf8") === next) return;
  const tmp = `${f}.tmp.${process.pid}`;
  writeFileSync(tmp, next);
  renameSync(tmp, f);
}

interface Applied {
  code: number;
  msg: string;
}

function applyOne(home: string, id: string): Applied {
  const data = readSug(home);
  const entry = data.suggestions.find((s) => s.id === id);
  if (!entry) return { code: 2, msg: `suggest apply: unknown id ${id}\n` };
  if (entry.status !== "pending") return { code: 2, msg: `suggest apply: ${id} is ${entry.status}, not pending\n` };
  const action = entry.action;
  const kind = action?.type;
  if (kind === "memory_record") {
    const m = action.memory ?? {};
    const buf: string[] = [];
    const rc = memoryAdd(
      home,
      { profile: m.profile ?? "", outcome: m.outcome ?? "", kind: m.task_kind ?? "", note: m.note ?? "", modelId: m.model_id ?? "" },
      (t) => buf.push(t),
    );
    if (rc !== 0) return { code: 1, msg: buf.join("") };
  } else if (kind === "profile_description") {
    const profile = action.profile ?? "";
    if (!profile) return { code: 2, msg: "profile_description apply: missing profile\n" };
    const cat = readJsonFile(join(home, "profiles.json"));
    if (!cat.profiles?.[profile]) {
      return { code: 2, msg: `profile ${profile}: unknown profile. Available: ${Object.keys(cat.profiles ?? {}).sort().join(", ")}\n` };
    }
    const desc = action.description || profileDescription(cat.profiles[profile]);
    if (!desc) return { code: 1, msg: `profile_description apply: could not generate description for ${profile}\n` };
    cat.profiles[profile].description = desc;
    profilesCommit(home, cat);
  } else if (kind === "model_description") {
    const mid = action.model_id ?? "";
    if (!mid) return { code: 2, msg: "model_description apply: missing model_id\n" };
    const cat = readJsonFile(join(home, "profiles.json"));
    if (!cat.models?.[mid]) return { code: 2, msg: `model_description apply: unknown model ${mid}\n` };
    const desc = action.description || modelDescription(mid, cat.models[mid]);
    if (!desc) return { code: 1, msg: `model_description apply: could not generate description for ${mid}\n` };
    cat.models[mid].description = desc;
    profilesCommit(home, cat);
  } else {
    return { code: 2, msg: `suggest apply: unsupported action type ${kind}\n` };
  }
  const fresh = readSug(home);
  fresh.suggestions = fresh.suggestions.map((s) => (s.id === id ? { ...s, status: "applied", applied: nowIso() } : s));
  writeAtomic(sugFile(home), fresh);
  return { code: 0, msg: "" };
}

function pendingRows(home: string): Sug[] {
  return readSug(home).suggestions.filter((s) => s.status === "pending");
}

export function applySafe(home: string): void {
  for (const s of pendingRows(home)) if (isAutoKind(s.kind)) applyOne(home, s.id);
}

const tsv = (v: unknown) => String(v ?? "").replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");

function suggestList(home: string, args: string[]): number {
  let pendingOnly = false;
  for (const a of args) {
    if (a === "--pending") pendingOnly = true;
    else {
      err(`suggest list: unknown argument ${a}\n`);
      return 2;
    }
  }
  const rows = readSug(home).suggestions;
  for (const s of pendingOnly ? rows.filter((r) => r.status === "pending") : rows) {
    const cols = pendingOnly ? [s.id, s.confidence, s.kind, s.title] : [s.id, s.status, s.confidence, s.kind, s.title];
    out(cols.map(tsv).join("\t") + "\n");
  }
  return 0;
}

function suggestApply(home: string, args: string[]): number {
  const ids: string[] = [];
  let all = false, asJson = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--all") all = true;
    else if (a === "--json") asJson = true;
    else if (a === "--id") {
      const v = args[++i];
      if (v) ids.push(v);
    } else if (a.startsWith("--")) {
      err(`suggest apply: unknown argument ${a}\n`);
      return 2;
    } else ids.push(a);
  }
  if (all) for (const s of pendingRows(home)) if (isAutoKind(s.kind)) ids.push(s.id);
  if (ids.length === 0) {
    err(`usage: ${APPLY_USAGE}\n`);
    return 2;
  }
  if (ids.length === 1 && !asJson && !all) {
    const r = applyOne(home, ids[0]);
    if (r.msg) err(r.msg);
    return r.code;
  }
  const results: any[] = [];
  let applied = 0, failed = 0;
  for (const id of ids) {
    if (!id) continue;
    const r = applyOne(home, id);
    if (r.code === 0) {
      applied++;
      results.push({ id, ok: true });
    } else {
      failed++;
      results.push({ id, ok: false, error: r.msg.replace(/\n+$/, "") });
    }
  }
  out(JSON.stringify({ ok: failed === 0, results, applied, failed }) + "\n");
  return failed === 0 ? 0 : 1;
}

function suggestDismiss(home: string, args: string[]): number {
  const id = args[0] ?? "";
  if (!id) {
    err(`usage: ${DISMISS_USAGE}\n`);
    return 2;
  }
  const data = readSug(home);
  data.suggestions = data.suggestions.map((s) => (s.id === id && s.status === "pending" ? { ...s, status: "dismissed" } : s));
  writeAtomic(sugFile(home), data);
  return 0;
}

export function learningAfterFinish(home: string, quiet: boolean): void {
  if (learningGet(home, "auto_scan_on_finish", "true") === "true") suggestScan(home, quiet);
  if (learningGet(home, "auto_apply_safe", "true") === "true") applySafe(home);
}

export async function suggestCommand(args: string[]): Promise<number> {
  const home = ioHome();
  const sub = args[0] ?? "";
  if (!(await ensureHome(home))) return 1;
  suggestEnsure(home);
  const rest = args.slice(1);
  switch (sub) {
    case "scan": return suggestScan(home) ? 0 : 1;
    case "list": return suggestList(home, rest);
    case "apply": return suggestApply(home, rest);
    case "dismiss": return suggestDismiss(home, rest);
    // Called by `run finish` after a run ends: scan and apply the safe kinds, by settings.
    case "finish": learningAfterFinish(home, false); return 0;
    default:
      err(`usage: ${SCAN_USAGE}\n${LIST_USAGE}\n${APPLY_USAGE}\n${DISMISS_USAGE}\n`);
      return 2;
  }
}

export async function dispatchSh(args: string[]): Promise<{ code: number; stdout: string }> {
  const dispatch = resolve(import.meta.dir, "../../scripts/dispatch.sh");
  const p = Bun.spawn(["bash", dispatch, ...args], {
    stdin: "ignore", stdout: "pipe", stderr: "inherit",
    env: { ...env(), HARNESS_ORCH_HOME: ioHome() } as Record<string, string>,
  });
  const stdout = await new Response(p.stdout).text();
  return { code: await p.exited, stdout };
}

// Reconciles on-disk state after offline CLI work and brings the dashboard back when possible.
export async function syncCommand(args: string[]): Promise<number> {
  let noServe = false;
  for (const a of args) {
    if (a === "--no-serve") noServe = true;
    else {
      err(`sync: unknown argument ${a}\n  usage: ${SYNC_USAGE}\n`);
      return 2;
    }
  }
  const home = ioHome();
  if (!(await ensureHome(home))) return 1;
  suggestEnsure(home);
  if (!noServe) {
    const d = await serveDiagnose(home);
    if (d.rc === 2) err("sync: dashboard unavailable (bun missing); CLI state on disk is still authoritative\n");
    else if (d.rc !== 0) {
      const rc = await quietStderr(() => serveRecover(["--start"]));
      if (rc !== 0) err("sync: could not start dashboard server; continuing disk sync\n");
    }
  }
  for (const { rid, s } of readRuns(home)) {
    if (s.status !== "running") continue;
    const r = await dispatchSh(["run", "sync", rid]);
    out(r.stdout);
  }
  await dispatchSh(["__loops-recover"]);
  suggestScan(home);
  if (learningGet(home, "auto_apply_safe", "true") === "true") applySafe(home);
  out("synced\n");
  return 0;
}
