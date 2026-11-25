// Auto-compaction of a coordinator session that a person started (orch never rotates those) once its prompt passes
// settings.coordinator_rotate_tokens. A backstop against coordinator sessions that grow to many hundred thousand tokens.
// settings.coordinator_autocompact (default true) turns it off.
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { settingFrom } from "../state/settings.ts";
import { opencodeDbPath } from "./owners.ts";

// At most one compaction request per run in this window.
export const AUTOCOMPACT_COOLDOWN_MS = 30 * 60_000;
// An unfinished assistant message older than this is an aborted turn, not a request in flight.
export const IN_FLIGHT_MAX_MS = 30 * 60_000;

/** The last compaction attempt, kept in the run's `coordinator.autocompact`. */
export interface AutocompactRecord {
  readonly at: string;
  readonly tokens: number;
  readonly result: string;
  readonly ok: boolean;
  /** False after a compaction until a reading below the threshold re-arms it. */
  readonly armed: boolean;
}

export type CompactVerdict = "below" | "cooldown" | "not re-armed" | "compact";

export type CompactOutcome = { readonly ok: true; readonly via: string } | { readonly ok: false; readonly why: string };

/** The ways to reach the session. `service` returns null when the shared service is not usable. */
export interface CompactRoutes {
  standalone(): Promise<boolean>;
  service(idempotencyId: string): Promise<{ ok: boolean; detail: string } | null>;
  terminal(): Promise<{ via: string } | { why: string }>;
}

type Doc = Parameters<typeof settingFrom>[0];

export function autocompactEnabledFrom(doc: Doc): boolean {
  return settingFrom(doc, "coordinator_autocompact", "true") !== "false";
}

export function autocompactVerdict(tokens: number, threshold: number, last: AutocompactRecord | null, nowMs: number): CompactVerdict {
  if (tokens < threshold) return "below";
  if (last && nowMs - Date.parse(last.at) < AUTOCOMPACT_COOLDOWN_MS) return "cooldown";
  if (last && last.ok && !last.armed) return "not re-armed";
  return "compact";
}

export function compactIdempotencyId(run: string, tokens: number): string {
  return `orch-compact-${run}-${Math.round(tokens / 10_000) * 10_000}`;
}

export const kTokens = (n: number): string => `${Math.round(n / 1000)}k`;

export function compactNotice(run: string, tokens: number, threshold: number): string {
  return `orch compacted this session at ${kTokens(tokens)} tokens (threshold ${kTokens(threshold)}). Each turn re-reads the whole context; for a fresh start run \`orch orchestrator rotate ${run} --tokens ${tokens} --summary "<decisions, open questions, next steps>"\`.`;
}

// A `--standalone` TUI runs a private server: the shared service may not own its session, so its terminal goes first.
export async function requestCompaction(routes: CompactRoutes, idempotencyId: string): Promise<CompactOutcome> {
  const why: string[] = [];
  const viaTerminal = async (): Promise<CompactOutcome | null> => {
    const t = await routes.terminal();
    if ("via" in t) return { ok: true, via: t.via };
    why.push(`terminal: ${t.why}`);
    return null;
  };
  const viaService = async (): Promise<CompactOutcome | null> => {
    const s = await routes.service(idempotencyId);
    if (s?.ok) return { ok: true, via: "service" };
    why.push(s ? `service: ${s.detail}` : "service: not available");
    return null;
  };
  const order = (await routes.standalone()) ? [viaTerminal, viaService] : [viaService, viaTerminal];
  for (const step of order) {
    const r = await step();
    if (r) return r;
  }
  return { ok: false, why: why.join("; ") };
}

// True when the session's newest assistant message has not completed yet and started under IN_FLIGHT_MAX_MS ago.
export function sessionInFlight(sessionId: string, nowMs: number, dbPath: string = opencodeDbPath()): boolean {
  if (!/^ses_[A-Za-z0-9]+$/.test(sessionId) || !existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query(
        `select json_extract(data,'$.time.created') as c, json_extract(data,'$.time.completed') as d
           from session_message where session_id = ? and type = 'assistant' order by seq desc limit 1`,
      ).get(sessionId) as { c: number | null; d: number | null } | null;
      return !!row && typeof row.c === "number" && row.d === null && nowMs - row.c < IN_FLIGHT_MAX_MS;
    } finally {
      db.close();
    }
  } catch (e) {
    if (e instanceof Error) process.stderr.write(`orchestrator check: in-flight read failed: ${e.message}\n`);
    return false;
  }
}

/** Routes over the existing coordinator delivery paths (inbox.ts) and the shared opencode service. */
export async function liveCompactRoutes(home: string, run: string, sessionId: string): Promise<CompactRoutes> {
  const [{ coordTypeLine }, { compactViaService }, { findSessionTerminal }] = await Promise.all([
    import("./inbox.ts"),
    import("../adapters/opencode-service.ts"),
    import("../adapters/session-terminal.ts"),
  ]);
  return {
    standalone: async () => {
      const f = await findSessionTerminal(sessionId);
      return f.terminal !== null && f.standalone;
    },
    service: (id) => compactViaService(sessionId, id),
    terminal: () => coordTypeLine(home, run, "/compact"),
  };
}

export interface AutocompactInput {
  readonly home: string;
  readonly run: string;
  readonly sessionId: string;
  readonly tokens: number;
  readonly threshold: number;
  readonly last: AutocompactRecord | null;
  readonly dry: boolean;
  readonly nowMs: number;
}

// The person-started branch of `orchestrator check`. Returns the one line the check prints.
export async function autocompactCheck(i: AutocompactInput, routes?: CompactRoutes): Promise<string> {
  const [{ mutateRun }, { appendEvents }, { nowIso }] = await Promise.all([
    import("./node.ts"),
    import("../state/store.ts"),
    import("../state/clock.ts"),
  ]);
  const verdict = autocompactVerdict(i.tokens, i.threshold, i.last, i.nowMs);
  const at = kTokens(i.tokens);
  if (verdict === "below") {
    if (i.last && !i.last.armed && !i.dry) {
      await mutateRun(i.home, i.run, (st) => { if (st.coordinator?.autocompact) st.coordinator.autocompact.armed = true; });
    }
    return `person-started: ok: ${i.tokens} < ${i.threshold}`;
  }
  if (verdict === "cooldown") return `person-started: cooldown at ${at}, last compaction under ${AUTOCOMPACT_COOLDOWN_MS / 60_000} min ago`;
  if (verdict === "not re-armed") return `person-started: not re-armed at ${at}, no reading below ${kTokens(i.threshold)} since the last compaction`;
  if (sessionInFlight(i.sessionId, i.nowMs)) return `person-started: request in flight at ${at}, compacts at a later check`;
  if (i.dry) return `person-started: would compact at ${at}`;
  const outcome = await requestCompaction(routes ?? (await liveCompactRoutes(i.home, i.run, i.sessionId)), compactIdempotencyId(i.run, i.tokens));
  const result = outcome.ok ? `compacted at ${at} via ${outcome.via}` : `compact failed at ${at}: ${outcome.why}`;
  const record: AutocompactRecord = { at: nowIso(), tokens: i.tokens, result, ok: outcome.ok, armed: !outcome.ok };
  await mutateRun(i.home, i.run, (st) => { if (st.coordinator) st.coordinator.autocompact = record; });
  await appendEvents(i.home, i.run, [{ at: record.at, kind: "note", node: null, from: null, to: null, note: `orchestrator autocompact: ${result} (threshold ${kTokens(i.threshold)})`, by: "watchdog" }]);
  if (outcome.ok) {
    const { tellOrchestrator } = await import("./inbox.ts");
    await tellOrchestrator(i.home, i.run, "watchdog", compactNotice(i.run, i.tokens, i.threshold));
  }
  return `person-started: ${result}`;
}
