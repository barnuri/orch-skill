import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { authHeaders } from "../api/chats";
import { followSse, type ConnState } from "../lib/sse";
import type { RunEvent } from "../../shared/types/run-event";
import { mergeEvents } from "../lib/run-activity";
import type { RequirementView } from "../../shared/types/run-requirements";
import type { HealthSummary, RunHealth } from "../../shared/types/run-health";
import { eventsSchema, healthSummarySchema, runHealthSchema, runRequirementsSchema, watchdogStatusSchema } from "./schemas";
import type { WatchdogStatus } from "../../shared/types/watchdog";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import { api } from "../api/client";
import { ApiFailure, conditionalGet, queryClient, useDocument } from "../api/queries";
import type { NonOk } from "../api/result";
import { asProfilesDocument } from "../lib/documents";
import { API_BASE, POLL_MS } from "../lib/constants";

export const runKeys = {
  runs: "runs",
  run: (id: string): string => `run:${id}`,
  events: (id: string): string => `run-events:${id}`,
  jobLog: (id: string): string => `job-log:${id}`,
  jobChat: (id: string): string => `job-chat:${id}`,
  nodeActivity: (run: string, node: string): string => `node-activity:${run}:${node}`,
  messages: (id: string): string => `run-messages:${id}`,
  health: (id: string): string => `run-health:${id}`,
  healthSummary: "health-summary",
  watchdog: "watchdog",
} as const;

const DEFAULT_MAX_ATTEMPTS = 5;

export function useRuns() {
  return useQuery({
    queryKey: [runKeys.runs],
    queryFn: () => conditionalGet(runKeys.runs, (etag) => api.getRuns(etag)),
    refetchInterval: POLL_MS,
  });
}

/** While the run's live stream is down, the run page falls back to this slower poll. */
export const OFFLINE_POLL_MS = 5000;

/** `live`: the stream is open. `connecting`: first connect. `offline`: the stream dropped, polling every 5 s. */
export type LiveState = "connecting" | "live" | "offline";

export function liveStateOf(conn: ConnState): LiveState {
  return conn === "open" ? "live" : conn === "connecting" ? "connecting" : "offline";
}

/** The poll interval for a run: POLL_MS while the stream is up (it only pushes done/error), else OFFLINE_POLL_MS. */
export function runPollMs(live: LiveState): number {
  return live === "live" ? POLL_MS : OFFLINE_POLL_MS;
}

/** A 404 is "pruned", not a failure to retry: the page shows its own notice. */
export function useRun(runId: string) {
  const [live, setLive] = useState<LiveState>("connecting");
  // Event-driven refresh: the server pushes a `node` event when a node turns done or error, and the
  // run and its activity feed refetch at once instead of on the next poll. The stream has no replay,
  // so a reconnect refetches too.
  useEffect(() => {
    const abort = new AbortController();
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: [runKeys.run(runId)] });
      void queryClient.invalidateQueries({ queryKey: [runKeys.events(runId)] });
      void queryClient.invalidateQueries({ queryKey: [runKeys.runs] });
    };
    let wasDown = false;
    void followSse({
      url: `${API_BASE}/runs/${encodeURIComponent(runId)}/live`,
      headers: authHeaders,
      resumeId: () => null,
      signal: abort.signal,
      onState: (conn) => {
        if (abort.signal.aborted) {
          return;
        }
        const next = liveStateOf(conn);
        if (next === "live" && wasDown) {
          refresh();
        }
        wasDown = next === "offline";
        setLive(next);
      },
      onEvents: refresh,
    });
    return () => abort.abort();
  }, [runId]);
  const query = useQuery({
    queryKey: [runKeys.run(runId)],
    queryFn: () => conditionalGet(runKeys.run(runId), (etag) => api.getRun(runId, etag)),
    refetchInterval: runPollMs(live),
  });
  return { ...query, live };
}

export function isNotFound(error: unknown): boolean {
  if (!(error instanceof ApiFailure)) {
    return false;
  }
  const result: NonOk = error.result;
  return result.kind === "error" && result.status === 404;
}

export interface ProfileFacts {
  /** profile name -> harness id, to pick the glyph of a node that has no `adapter` yet. */
  harnessByProfile: Record<string, string>;
  maxAttempts: number;
}

export function profileFacts(document: ProfilesDocument | null): ProfileFacts {
  const harnessByProfile: Record<string, string> = {};
  if (document === null) {
    return { harnessByProfile, maxAttempts: DEFAULT_MAX_ATTEMPTS };
  }
  for (const [name, spec] of Object.entries(document.profiles)) {
    if (typeof spec.harness === "string" && spec.harness !== "") {
      harnessByProfile[name] = spec.harness;
    }
  }
  const value = document.settings.max_attempts;
  const valid = value !== undefined && Number.isInteger(value) && (value === -1 || value >= 1);
  return { harnessByProfile, maxAttempts: valid ? value : DEFAULT_MAX_ATTEMPTS };
}

/** The run page never polls profiles.json: it reads the cached copy once, for glyphs and the attempt cap. */
export function useProfileFacts(): ProfileFacts {
  const profiles = useDocument("profiles", false);
  return profileFacts(profiles.data === undefined ? null : asProfilesDocument(profiles.data.document));
}

/** Fetched on demand, not on the 2 s poll: a transcript is large and does not change once the job exits. */
export function useJobLog(jobId: string | null) {
  return useQuery({
    queryKey: [runKeys.jobLog(jobId ?? "")],
    enabled: jobId !== null && jobId !== "",
    queryFn: async () => {
      const result = await api.getJobLog(jobId ?? "");
      if (result.kind !== "ok") {
        throw new ApiFailure(result as NonOk);
      }
      return result.body;
    },
    staleTime: 2000,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
  });
}

export function useJobChat(jobId: string | null) {
  return useQuery({
    queryKey: [runKeys.jobChat(jobId ?? "")],
    enabled: jobId !== null && jobId !== "",
    queryFn: async () => {
      const result = await api.getJobChat(jobId ?? "");
      if (result.kind !== "ok") {
        throw new ApiFailure(result as NonOk);
      }
      return result.body;
    },
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}


/** Polls the owner's activity every 3 s, only while the panel is mounted and the tab is visible. */
export function useNodeActivity(runId: string, nodeId: string, enabled: boolean, live = true) {
  return useQuery({
    queryKey: [runKeys.nodeActivity(runId, nodeId)],
    enabled,
    queryFn: async () => {
      const result = await api.getNodeActivity(runId, nodeId);
      if (result.kind !== "ok") {
        throw new ApiFailure(result as NonOk);
      }
      return result.body;
    },
    refetchInterval: live ? 3000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** The run's inbox messages, polled every 5 s while a node panel is open on a live run. */
export function useRunMessages(runId: string, live: boolean) {
  return useQuery({
    queryKey: [runKeys.messages(runId)],
    queryFn: async () => {
      const result = await api.getRunMessages(runId);
      if (result.kind !== "ok") {
        throw new ApiFailure(result as NonOk);
      }
      return result.body.messages;
    },
    refetchInterval: live ? 5000 : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** The cached activity of a node (no fetch): the card tooltip reads what the panel already loaded. */
export function useCachedNodeActivity(runId: string, nodeId: string) {
  return useQuery({ queryKey: [runKeys.nodeActivity(runId, nodeId)], enabled: false, queryFn: () => null as never });
}

/** The run's activity feed, oldest first: each poll asks only for events after the newest one held. */
export function useRunEvents(runId: string): RunEvent[] {
  const held = useRef<RunEvent[]>([]);
  const query = useQuery({
    queryKey: [runKeys.events(runId)],
    queryFn: async () => {
      const after = held.current.at(-1)?.n ?? 0;
      const result = await api.request("GET", `${API_BASE}/runs/${encodeURIComponent(runId)}/events?after=${after}`, eventsSchema, { quiet: true });
      if (result.kind !== "ok") {
        throw new ApiFailure(result as NonOk);
      }
      held.current = mergeEvents(held.current, result.body.events);
      return held.current;
    },
    refetchInterval: POLL_MS,
    retry: false,
  });
  return query.data ?? [];
}

/** A run's requirements ledger, on the same POLL_MS as the run. */
export function useRunRequirements(runId: string): RequirementView[] {
  const query = useQuery({
    queryKey: [`run-requirements:${runId}`],
    queryFn: async () => {
      const result = await api.request("GET", `${API_BASE}/runs/${encodeURIComponent(runId)}/requirements`, runRequirementsSchema, { quiet: true });
      if (result.kind !== "ok") {
        throw new ApiFailure(result as NonOk);
      }
      return result.body.requirements;
    },
    refetchInterval: POLL_MS,
    retry: false,
  });
  return query.data ?? [];
}

async function fetchRunHealth(runId: string): Promise<RunHealth | null> {
  const result = await api.request("GET", `${API_BASE}/runs/${encodeURIComponent(runId)}/health`, runHealthSchema, { quiet: true });
  if (result.kind !== "ok") {
    throw new ApiFailure(result as NonOk);
  }
  return result.body.health;
}

/** A run's latest node-health check (the server keeps it in memory), on the same POLL_MS as the run. */
export function useRunHealth(runId: string, enabled = true): RunHealth | null {
  const query = useQuery({
    queryKey: [runKeys.health(runId)],
    enabled,
    queryFn: () => fetchRunHealth(runId),
    refetchInterval: POLL_MS,
    retry: false,
  });
  return query.data ?? null;
}

/** The health of several runs at once (the running ones), keyed by run id; same POLL_MS. */
export function useRunsHealth(runIds: readonly string[]): ReadonlyMap<string, RunHealth> {
  const results = useQueries({
    queries: runIds.map((id) => ({
      queryKey: [runKeys.health(id)],
      queryFn: () => fetchRunHealth(id),
      refetchInterval: POLL_MS,
      retry: false,
    })),
  });
  const out = new Map<string, RunHealth>();
  runIds.forEach((id, i) => {
    const data = results[i]?.data;
    if (data !== undefined && data !== null) {
      out.set(id, data);
    }
  });
  return out;
}

/** The header's node-health counts: one small in-memory read every 10 s, paused while the tab is hidden. */
export const HEALTH_SUMMARY_POLL_MS = 10_000;

export function useHealthSummary(): HealthSummary | null {
  const query = useQuery({
    queryKey: [runKeys.healthSummary],
    queryFn: async () => {
      const result = await api.request("GET", `${API_BASE}/health/summary`, healthSummarySchema, { quiet: true });
      if (result.kind !== "ok") {
        throw new ApiFailure(result as NonOk);
      }
      return result.body;
    },
    refetchInterval: HEALTH_SUMMARY_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return query.data ?? null;
}

/** The header's watchdog pill: one in-memory read every 10 s, paused while the tab is hidden. */
export function useWatchdog(): WatchdogStatus | null {
  const query = useQuery({
    queryKey: [runKeys.watchdog],
    queryFn: async () => {
      const result = await api.request("GET", `${API_BASE}/watchdog`, watchdogStatusSchema, { quiet: true });
      if (result.kind !== "ok") {
        throw new ApiFailure(result as NonOk);
      }
      return result.body;
    },
    refetchInterval: HEALTH_SUMMARY_POLL_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return query.data ?? null;
}
