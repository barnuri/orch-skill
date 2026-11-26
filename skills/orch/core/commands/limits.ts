// `limits show | set | clear | resume` and checkLimits, the pause that run sync, run advance and node dispatch call.
// See core/limits.ts for the rules and references/state-and-config.md for the keys.
import { orchHome, paths } from "../state/home.ts";
import { loadRun } from "../state/store.ts";
import { loadProfilesDoc } from "../state/settings.ts";
import { profilesCommit } from "../state/profiles.ts";
import { ev, findNode } from "../runs/node.ts";
import { errLine, mutateRun, resolveRun } from "./node.ts";
import {
  anyLimit, effectiveLimits, nodeUsd, evaluateLimits, hitText, parseLimitValue, readLimitInputs, runSessions, settingsLimits, USD_KEYS,
  type LimitHit,
} from "../limits.ts";

export const LIMITS_USAGE = [
  "dispatch.ts limits show [--run R] [--json]",
  "dispatch.ts limits set <node_usd|run_usd|session_usd|profile_pct.<profile>> <value|off> [--run R]",
  "dispatch.ts limits clear [<key>] [--run R]",
  "dispatch.ts limits resume <run-id> (--raise <value> | --ignore)",
].join("\n");

const out = (s: string) => void process.stdout.write(s);
type Obj = Record<string, any>;

/**
 * Checks the run's limits and pauses the run on a limit it has not reported yet: `paused`, an event per hit,
 * `limit_hit` / `limit_hits` on the run, `limit_reached` on a node over its own limit (its retries stop), and a
 * message to the orchestrator. Running nodes are never killed. Returns the new hits ([] when none).
 */
export async function checkLimits(home: string, runId: string): Promise<LimitHit[]> {
  const run = await loadRun(home, runId);
  if (!run || run.stopped === true || run.status !== "running") return [];
  const doc = await loadProfilesDoc(home);
  const { limits } = effectiveLimits(doc, run);
  if (!anyLimit(limits)) return [];
  const hits = evaluateLimits(run, doc, await readLimitInputs(run, doc, limits));
  const seen = new Set<string>(((run.limit_hits ?? []) as Obj[]).map((h) => String(h.key)));
  const fresh = hits.filter((h) => !seen.has(h.key));
  if (fresh.length === 0) return [];
  const rc = await mutateRun(home, runId, (r, ctx) => {
    if (r.paused !== true) {
      r.paused = true;
      r.paused_at = ctx.now;
    }
    // A limit pause never resumes by itself at service boot.
    r.auto_resume = false;
    const stamped = fresh.map((h) => ({ ...h, at: ctx.now }));
    r.limit_hit = stamped[0];
    r.limit_hits = [...((r.limit_hits ?? []) as Obj[]), ...stamped];
    for (const h of stamped) {
      if (h.node) {
        const n = findNode(r, h.node);
        if (n) {
          n.limit_reached = { limit: h.limit, value: h.value, at: ctx.now };
          n.next_retry_at = null;
        }
      }
      ev(ctx, "limit", h.node ?? "", "", "paused", `limit reached: ${hitText(h)}`);
    }
  });
  if (rc !== 0) return [];
  const text = `limit reached, run paused: ${fresh.map(hitText).join("; ")}. Running nodes finish. ` +
    `Resume: dispatch.ts limits resume ${runId} --raise <value> | --ignore`;
  try {
    const { tellOrchestrator } = await import("./inbox.ts");
    await tellOrchestrator(home, runId, "limits", text);
  } catch {
    // The run event and the run page banner still show the hit.
  }
  return fresh;
}

// ---- CLI -------------------------------------------------------------------------------------------------

function takeRun(args: string[]): { run: string; json: boolean; rest: string[] } | null {
  let run = "";
  let json = false;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--run") {
      run = args[++i] ?? "";
      if (!run) return null;
    } else if (a === "--json") json = true;
    else rest.push(a);
  }
  return { run, json, rest };
}

function validKey(key: string): boolean {
  return (USD_KEYS as readonly string[]).includes(key) || /^profile_pct\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key);
}

/** Writes one key into a limits object; null keeps the key with "off". `undefined` removes it. */
function put(obj: Obj, key: string, value: number | null | undefined): void {
  if (key.startsWith("profile_pct.")) {
    const p = key.slice("profile_pct.".length);
    const pct = { ...(obj.profile_pct ?? {}) };
    if (value === undefined) delete pct[p];
    else pct[p] = value;
    if (Object.keys(pct).length) obj.profile_pct = pct;
    else delete obj.profile_pct;
    return;
  }
  if (value === undefined) delete obj[key];
  else obj[key] = value;
}

async function runReport(home: string, runId: string): Promise<Obj | null> {
  const run = await loadRun(home, runId);
  if (!run) return null;
  const doc = await loadProfilesDoc(home);
  const { limits, source } = effectiveLimits(doc, run);
  const inputs = await readLimitInputs(run, doc, { ...limits, session_usd: limits.session_usd ?? 0 });
  const nodes = Object.fromEntries(run.nodes.map((n) => [n.id, nodeUsd(n)]).filter(([, v]) => v !== null));
  const runUsd = Object.values(nodes).reduce((a: number, v) => a + (v as number), 0);
  return {
    run: runId, limits, source, ignore: run.limits?.ignore ?? [],
    usage: { run_usd: Math.round(runUsd * 10000) / 10000, nodes, sessions: inputs.sessionUsd, session_ids: runSessions(run), profile_pct: inputs.profilePct },
    hits: evaluateLimits(run, doc, inputs), limit_hit: run.limit_hit ?? null, paused: run.paused === true,
  };
}

export async function limitsShow(args: string[]): Promise<number> {
  const a = takeRun(args);
  if (!a || a.rest.length) return (errLine(`usage: ${LIMITS_USAGE}`), 2);
  const home = orchHome();
  if (!a.run) {
    const l = settingsLimits(await loadProfilesDoc(home));
    if (a.json) return (out(JSON.stringify({ limits: l }) + "\n"), 0);
    const show = (v: number | null) => (v === null ? "off" : String(v));
    out(`node_usd: ${show(l.node_usd)}\nrun_usd: ${show(l.run_usd)}\nsession_usd: ${show(l.session_usd)}\n`);
    for (const [p, v] of Object.entries(l.profile_pct)) out(`profile_pct.${p}: ${v}\n`);
    return 0;
  }
  const runId = await resolveRun(home, a.run);
  if (runId === null) return 1;
  const rep = await runReport(home, runId);
  if (!rep) return (errLine(`run ${runId}: unknown run`), 2);
  if (a.json) return (out(JSON.stringify(rep) + "\n"), 0);
  const show = (k: string, v: number | null) => (v === null ? "off" : `${v} (${rep.source[k] ?? "settings"})`);
  for (const k of USD_KEYS) out(`${k}: ${show(k, rep.limits[k])}\n`);
  for (const [p, v] of Object.entries(rep.limits.profile_pct as Obj)) out(`profile_pct.${p}: ${show(`profile_pct:${p}`, v as number)}\n`);
  out(`spent: run $${rep.usage.run_usd.toFixed(2)}`);
  for (const [s, v] of Object.entries(rep.usage.sessions as Obj)) out(`, session ${s} $${(v as number).toFixed(2)}`);
  out("\n");
  if (rep.ignore.length) out(`ignored: ${rep.ignore.join(",")}\n`);
  for (const h of rep.hits as LimitHit[]) out(`reached: ${hitText(h)}\n`);
  return 0;
}

export async function limitsSet(args: string[]): Promise<number> {
  const a = takeRun(args);
  if (!a || a.rest.length !== 2) return (errLine(`usage: ${LIMITS_USAGE}`), 2);
  const [key = "", raw = ""] = a.rest;
  if (!validKey(key)) return (errLine(`limits set: unknown key ${key} (node_usd, run_usd, session_usd, profile_pct.<profile>)`), 2);
  const value = parseLimitValue(raw);
  if (value === undefined) return (errLine("limits set: value must be a non-negative number or off"), 2);
  if (key.startsWith("profile_pct.") && value !== null && value > 100) return (errLine("limits set: profile_pct must be 0-100"), 2);
  const home = orchHome();
  if (a.run) {
    const runId = await resolveRun(home, a.run);
    if (runId === null) return 1;
    const rc = await mutateRun(home, runId, (r, ctx) => {
      const l = { ...(r.limits ?? {}) };
      put(l, key, value);
      r.limits = l;
      ev(ctx, "note", "", "", "", `limit ${key} ${value === null ? "off" : value} for this run`);
    });
    if (rc === 0) out(`${key} = ${value === null ? "off" : value} (run ${runId})\n`);
    return rc;
  }
  try {
    const doc: Obj = await Bun.file(paths.profiles(home)).json();
    const s = { ...(doc.settings ?? {}) };
    const l = { ...(s.limits ?? {}) };
    // A setting has no "off for this run" meaning: off removes it.
    put(l, key, value === null ? undefined : value);
    s.limits = l;
    doc.settings = s;
    profilesCommit(home, doc);
  } catch {
    return (errLine("limits set: could not write profiles.json"), 1);
  }
  out(`${key} = ${value === null ? "off" : value}\n`);
  return 0;
}

export async function limitsClear(args: string[]): Promise<number> {
  const a = takeRun(args);
  if (!a || a.rest.length > 1) return (errLine(`usage: ${LIMITS_USAGE}`), 2);
  const key = a.rest[0] ?? "";
  if (key && !validKey(key)) return (errLine(`limits clear: unknown key ${key}`), 2);
  const home = orchHome();
  if (a.run) {
    const runId = await resolveRun(home, a.run);
    if (runId === null) return 1;
    const rc = await mutateRun(home, runId, (r, ctx) => {
      if (!key) delete r.limits;
      else {
        const l = { ...(r.limits ?? {}) };
        put(l, key, undefined);
        r.limits = l;
      }
      ev(ctx, "note", "", "", "", `run limit ${key || "overrides"} cleared`);
    });
    if (rc === 0) out(`cleared: ${key || "all run limits"} (run ${runId})\n`);
    return rc;
  }
  try {
    const doc: Obj = await Bun.file(paths.profiles(home)).json();
    const s = { ...(doc.settings ?? {}) };
    if (!key) delete s.limits;
    else {
      const l = { ...(s.limits ?? {}) };
      put(l, key, undefined);
      s.limits = l;
    }
    doc.settings = s;
    profilesCommit(home, doc);
  } catch {
    return (errLine("limits clear: could not write profiles.json"), 1);
  }
  out(`cleared: ${key || "all limits"}\n`);
  return 0;
}

/**
 * Resumes a run a limit paused: --raise sets the first hit's limit for this run to the new value, --ignore skips
 * every reported hit for this run. Nodes no longer over a limit lose `limit_reached`, then `run resume` runs.
 */
export async function limitsResume(args: string[]): Promise<number> {
  const runArg = args[0] ?? "";
  let raise: number | null | undefined;
  let ignore = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--ignore") ignore = true;
    else if (a === "--raise") {
      raise = parseLimitValue(args[++i] ?? "x");
      if (raise === undefined || raise === null) return (errLine("limits resume: --raise needs a non-negative number"), 2);
    } else return (errLine(`usage: ${LIMITS_USAGE}`), 2);
  }
  if (!runArg || (raise === undefined) === !ignore) return (errLine(`usage: ${LIMITS_USAGE}\n  pass exactly one of --raise <value> or --ignore`), 2);
  const home = orchHome();
  const runId = await resolveRun(home, runArg);
  if (runId === null) return 1;
  const run = await loadRun(home, runId);
  if (!run) return (errLine(`run ${runId}: unknown run`), 2);
  const hit = run.limit_hit as LimitHit | undefined;
  if (!hit) return (errLine(`limits resume: ${runId} is not paused by a limit (use run resume)`), 3);
  if (raise !== undefined && raise !== null && raise <= hit.value) {
    return (errLine(`limits resume: --raise ${raise} is not above the current ${hit.value}; the limit would pause the run again`), 2);
  }
  const doc = await loadProfilesDoc(home);
  const rc = await mutateRun(home, runId, (r, ctx) => {
    const l: Obj = { ...(r.limits ?? {}) };
    if (ignore) l.ignore = [...new Set([...(l.ignore ?? []), ...((r.limit_hits ?? []) as Obj[]).map((h) => String(h.key))])];
    else put(l, hit.kind === "profile_pct" ? `profile_pct.${hit.profile}` : hit.kind, raise as number);
    r.limits = l;
    r.limit_hit = null;
    r.limit_hits = [];
    // A node keeps limit_reached only while it is still over a limit in force.
    const still = new Set(evaluateLimits(r, doc, { sessionUsd: {}, profilePct: {} }).map((h) => h.node).filter(Boolean));
    for (const n of r.nodes) if (n.limit_reached && !still.has(n.id)) delete n.limit_reached;
    ev(ctx, "limit", "", "paused", "resumed", ignore ? `limit ignored: ${hitText(hit)}` : `limit raised to ${raise}: ${hitText(hit)}`);
  });
  if (rc !== 0) return rc;
  const { runResume } = await import("./pause.ts");
  return runResume([runId]);
}
