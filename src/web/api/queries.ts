import { QueryClient, useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type { DocumentKind } from "../../shared/types/document-kind";
import { POLL_MS } from "../lib/constants";
import { api } from "./client";
import type { ApiResult, NonOk } from "./result";
import { describeFailure } from "./result";
import type { LoadedEnvelope } from "./schemas";

/** A document envelope plus the ETag it came with: the `If-Match` of the next save. */
export interface LoadedDocument extends LoadedEnvelope {
  etag: string;
}

/** Thrown by a queryFn so react-query keeps the failure; `result` is the original non-ok outcome. */
export class ApiFailure extends Error {
  constructor(readonly result: NonOk) {
    super(describeFailure(result, "request failed"));
  }
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true, staleTime: 0 } },
});

interface Cached {
  etag: string;
  body: unknown;
}

// Conditional GETs: the last body and ETag per query key. A 304 answers with the cached body, so
// react-query's structural sharing sees the same object and the page does not re-render.
const cache = new Map<string, Cached>();

export function dropEtags(): void {
  cache.clear();
}

export function dropEtag(key: string): void {
  cache.delete(key);
}

export async function conditionalGet<T, R = T>(
  key: string,
  fetcher: (etag: string | null) => Promise<ApiResult<T>>,
  shape: (body: T, etag: string) => R = (body) => body as unknown as R,
): Promise<R> {
  const previous = cache.get(key);
  let result = await fetcher(previous?.etag ?? null);
  if (result.kind === "unchanged") {
    if (previous !== undefined) {
      return previous.body as R;
    }
    result = await fetcher(null);
  }
  if (result.kind === "ok") {
    const shaped = shape(result.body, result.etag ?? "");
    if (result.etag !== null) {
      cache.set(key, { etag: result.etag, body: shaped });
    }
    return shaped;
  }
  throw new ApiFailure(result as NonOk);
}

export const keys = {
  active: "active",
  schedules: "schedules",
  harnesses: "harnesses",
  document: (kind: DocumentKind): string => `document:${kind}`,
} as const;

let forceHarnessProbe = false;

/** The refresh button on the harnesses page skips the server's probe cache, like Re-detect. */
export function forceNextHarnessProbe(): void {
  forceHarnessProbe = true;
}

export function useActive() {
  return useQuery({
    queryKey: [keys.active],
    queryFn: () => conditionalGet(keys.active, (etag) => api.getActive(etag)),
    refetchInterval: POLL_MS,
  });
}

/** `poll` false is for pages that only need the document's current value (profile names). */
export function useDocument(kind: DocumentKind, poll = true): UseQueryResult<LoadedDocument> {
  return useQuery({
    queryKey: [keys.document(kind)],
    queryFn: () =>
      conditionalGet(keys.document(kind), (etag) => api.getDocument(kind, etag), (body, etag): LoadedDocument => ({ ...body, etag })),
    refetchInterval: poll ? POLL_MS : false,
    refetchOnWindowFocus: poll,
    staleTime: poll ? 0 : 60_000,
  });
}

export function useSchedules() {
  return useQuery({
    queryKey: [keys.schedules],
    queryFn: () => conditionalGet(keys.schedules, (etag) => api.getSchedules(etag)),
    refetchInterval: POLL_MS,
  });
}

export function useHarnesses() {
  return useQuery({
    queryKey: [keys.harnesses],
    queryFn: async () => {
      const force = forceHarnessProbe;
      forceHarnessProbe = false;
      const result = await api.getHarnesses(force);
      if (result.kind !== "ok") {
        throw new ApiFailure(result as NonOk);
      }
      return result.body;
    },
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
}

export function invalidateDocument(kind: DocumentKind): Promise<void> {
  dropEtag(keys.document(kind));
  return queryClient.invalidateQueries({ queryKey: [keys.document(kind)] });
}

export function invalidateSchedules(): Promise<void> {
  dropEtag(keys.schedules);
  return queryClient.invalidateQueries({ queryKey: [keys.schedules] });
}

const MIN_REFRESH_MS = 450;

/**
 * The refresh button: drops every cached "unchanged" tag and refetches the active queries at once,
 * bypassing the conditional caches. Takes at least MIN_REFRESH_MS so the spinner is seen even when
 * the server answers instantly.
 */
export async function refreshPage(routeKind: string): Promise<void> {
  dropEtags();
  if (routeKind === "harnesses") {
    forceNextHarnessProbe();
  }
  await Promise.all([
    queryClient.refetchQueries({ type: "active" }),
    new Promise<void>((done) => setTimeout(done, MIN_REFRESH_MS)),
  ]);
}
