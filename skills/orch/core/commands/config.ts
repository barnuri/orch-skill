// `init`, `settings`, `profile sanity | unset-env | sync-overlay` and `memory add | list`.
// Ported from lib/core/config.sh and lib/adapters/profile-sanity.sh. Bun built-ins only.
import { existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { nowIso } from "../state/clock.ts";
import { trashPath } from "../state/trash.ts";
import { ensureHome, overlayFile, profilesCommit } from "../state/profiles.ts";
import { loadProfilesDoc } from "../state/settings.ts";
import { hasHarnessDisabled, modelIdResolve, modelSlugResolve, readCatalog } from "../adapters/routing.ts";
import { loadProfile } from "../adapters/spawn.ts";
import { MEMORY_ADD_USAGE, memoryAdd } from "./suggest.ts";

const err = (s: string, code: number): number => (process.stderr.write(s), code);
const out = (s: string): number => (s !== "" && process.stdout.write(s), 0);

export const SETTINGS_USAGE = "dispatch.ts settings get defaults.<key> | set defaults.<key> <value>";
export const PROFILE_SANITY_USAGE = "dispatch.ts profile sanity [--profile NAME] [--json]";
const SANITY_PROMPT = "orch sanity check: respond with exactly the word OK and nothing else.";
const MEMORY_LIST_DEFAULT = 20;

async function requireHome(): Promise<string | null> {
  const home = orchHome();
  return (await ensureHome(home)) ? home : null;
}

// init: bootstrap the home, trash the retired file:// dashboard leftovers, print the path.
export async function init(args: string[]): Promise<number> {
  const home = await requireHome();
  if (!home) return 1;
  for (const n of ["index.html", "data"]) {
    const p = join(home, n);
    if (!existsSync(p)) continue;
    await trashPath(home, p);
    if (!process.env.ORCH_INSTALL_QUIET) process.stderr.write(`orch: moved legacy dashboard leftover ${n}\n`);
  }
  const dispatch = process.env.ORCH_DISPATCH || resolve(import.meta.dir, "../../scripts/dispatch.ts");
  try {
    const tmp = join(home, `.dispatch-path.tmp.${process.pid}`);
    writeFileSync(tmp, realpathSync(dispatch) + "\n");
    renameSync(tmp, join(home, ".dispatch-path"));
  } catch {}
  return args.includes("--quiet") ? 0 : out(home + "\n");
}

export async function settings(args: string[]): Promise<number> {
  const [sub = "", key = "", value = ""] = args;
  const home = await requireHome();
  if (!home) return 1;
  const usage = () => err(`usage: ${SETTINGS_USAGE}\n`, 2);
  if (sub === "get") {
    if (key === "") return usage();
    const doc = await loadProfilesDoc(home);
    const v = (doc.defaults ?? {})[key.replace(/^defaults\./, "")];
    return out(JSON.stringify(v === undefined || v === null || v === false ? "null" : v) + "\n");
  }
  if (sub !== "set") return usage();
  if (key === "" || args.length < 3) return usage();
  let v: number | boolean;
  if (key === "defaults.max_parallel") {
    if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 32) return err("settings set: defaults.max_parallel must be an integer 1-32\n", 2);
    v = Number(value);
  } else if (key === "defaults.parallel_ok") {
    if (value !== "true" && value !== "false") return err("settings set: defaults.parallel_ok must be true or false\n", 2);
    v = value === "true";
  } else return err(`settings set: unknown key ${key} (settable: defaults.max_parallel, defaults.parallel_ok)\n`, 2);
  const k = key.replace(/^defaults\./, "");
  try {
    const doc: any = await Bun.file(paths.profiles(home)).json();
    doc.defaults = { ...(doc.defaults ?? {}), [k]: v };
    if (k === "max_parallel" && doc.settings) delete doc.settings.max_parallel;
    profilesCommit(home, doc);
  } catch {
    return err("settings set: could not write profiles.json\n", 1);
  }
  return out(`${key} = ${v}\n`);
}

type Row = Record<string, unknown>;

async function probeOne(home: string, name: string): Promise<Row> {
  const cat = await readCatalog(paths.profiles(home));
  const prof = cat.profiles?.[name];
  const base = { profile: name, ok: false, ms: 0, model_id: "", slug: "", bytes: 0 };
  if (!prof) return { ...base, status: "unknown", harness: "", exit_code: 2, error: "unknown profile" };
  const harness: string = prof.harness ?? "";
  if (typeof prof.enabled === "boolean" ? !prof.enabled : false) return { ...base, status: "disabled", harness, exit_code: 0, error: "profile disabled" };
  if (hasHarnessDisabled(cat, harness)) return { ...base, status: "disabled", harness, exit_code: 0, error: "harness disabled" };
  const modelId = modelIdResolve(cat, name) ?? "";
  const slug = modelId ? (modelSlugResolve(cat, name, modelId) ?? "") : "";
  const logs: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: string) => (logs.push(String(s)), true);
  let loaded;
  try {
    loaded = await loadProfile(home, name, { ...process.env });
  } finally {
    (process.stderr as any).write = realWrite;
  }
  if (!loaded.ok) {
    const last = logs.join("").trim().split("\n").pop() ?? "";
    return { ...base, status: loaded.rc === 3 ? "unconfigured" : "failed", harness, model_id: modelId, slug, exit_code: loaded.rc, error: last };
  }
  const start = Date.now();
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../../scripts/dispatch.ts"), "run", "--profile", name, SANITY_PROMPT], {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env as Record<string, string>,
  });
  const [o, e] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
  const rc = await proc.exited;
  return {
    profile: name, ok: rc === 0, status: rc === 0 ? "ok" : "failed", ms: Date.now() - start, harness, model_id: modelId, slug,
    exit_code: rc, bytes: Buffer.byteLength(o), error: e,
  };
}

export async function profileSanity(args: string[]): Promise<number> {
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--profile") {
      const v = args[++i] ?? "";
      if (v !== "") names.push(v);
    } else if (a !== "--json") return err(`profile sanity: unknown argument ${a}\n`, 2);
  }
  const home = await requireHome();
  if (!home) return 1;
  if (names.length === 0) names.push(...Object.keys((await readCatalog(paths.profiles(home))).profiles ?? {}).sort());
  const results: Row[] = [];
  for (const n of names) results.push(await probeOne(home, n));
  return out(JSON.stringify({ generated_at: nowIso(), results }) + "\n");
}

export async function profileUnsetEnv(args: string[]): Promise<number> {
  const [name = "", ...vars] = args;
  if (name === "" || vars.length === 0) return err("usage: dispatch.ts profile unset-env <name> <VAR>...\n", 2);
  const home = await requireHome();
  if (!home) return 1;
  const doc: any = await Bun.file(paths.profiles(home)).json();
  const p = doc.profiles?.[name];
  if (!p) return err(`profile ${name}: unknown profile. Available: ${Object.keys(doc.profiles ?? {}).sort().join(", ")}\n`, 2);
  p.env = Object.fromEntries(Object.entries(p.env ?? {}).filter(([k]) => !vars.includes(k)));
  profilesCommit(home, doc);
  return 0;
}

// Adds the profiles (and their models) of the gitignored overlay that the live profiles.json lacks.
// --replace NAME... also replaces the named profiles. Never overwrites any other existing profile.
export async function profileSyncOverlay(args: string[]): Promise<number> {
  const home = await requireHome();
  if (!home) return 1;
  let rep: string[] = [];
  if (args[0] === "--replace") rep = args.slice(1);
  const ovf = overlayFile();
  if (!existsSync(ovf)) return err(`profile sync-overlay: no overlay at ${ovf}\n`, 1);
  try {
    const doc: any = await Bun.file(paths.profiles(home)).json();
    const ov: any = await Bun.file(ovf).json();
    const before = Object.keys(doc.profiles ?? {}).length;
    const keep = Object.fromEntries(Object.entries<any>(doc.profiles ?? {}).filter(([k]) => !rep.includes(k)));
    const added = Object.fromEntries(Object.entries<any>(ov.profiles ?? {}).filter(([k]) => rep.includes(k) || keep[k] == null));
    doc.profiles = { ...added, ...keep };
    doc.models = { ...(ov.models ?? {}), ...(doc.models ?? {}) };
    if (rep.length > 0) {
      const used = Object.entries<any>(ov.profiles ?? {}).filter(([k]) => rep.includes(k)).map(([, v]) => v.model);
      for (const [k, v] of Object.entries<any>(ov.models ?? {})) if (used.includes(k)) doc.models[k] = v;
    }
    profilesCommit(home, doc);
    return out(`profile sync-overlay: ${Object.keys(doc.profiles).length - before} profile(s) added\n`);
  } catch {
    return err("profile sync-overlay: could not merge\n", 1);
  }
}

export async function memory(args: string[]): Promise<number> {
  const [sub = "", ...rest] = args;
  const home = await requireHome();
  if (!home) return 1;
  if (sub === "add") {
    const a = { profile: "", outcome: "", kind: "", note: "", modelId: "" };
    for (let i = 0; i < rest.length; i++) {
      const f = rest[i]!;
      const v = rest[i + 1] ?? "";
      if (f === "--profile") a.profile = v;
      else if (f === "--outcome") a.outcome = v;
      else if (f === "--kind") a.kind = v;
      else if (f === "--note") a.note = v;
      else if (f === "--model-id") a.modelId = v;
      else return err(`memory add: unknown argument ${f}\n`, 2);
      i++;
    }
    return memoryAdd(home, a);
  }
  if (sub === "list") {
    let profile = "";
    let n = String(MEMORY_LIST_DEFAULT);
    for (let i = 0; i < rest.length; i++) {
      const f = rest[i]!;
      if (f === "--profile") profile = rest[++i] ?? "";
      else if (f === "-n") n = rest[++i] ?? String(MEMORY_LIST_DEFAULT);
      else return err(`memory list: unknown argument ${f}\n`, 2);
    }
    if (!/^[0-9]+$/.test(n)) return err("memory list: -n expects a number\n", 2);
    const rows: any[] = await Bun.file(join(home, "memory.json")).json();
    const lines = rows
      .filter((r) => profile === "" || r.profile === profile)
      .reverse()
      .slice(0, Number(n))
      .map((r) => [r.ts, r.profile, r.outcome, r.task_kind, r.note].map((x) => String(x ?? "").replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r")).join("\t") + "\n");
    return out(lines.join(""));
  }
  return err(`usage: ${MEMORY_ADD_USAGE} | dispatch.ts memory list [--profile P] [-n N]\n`, 2);
}
