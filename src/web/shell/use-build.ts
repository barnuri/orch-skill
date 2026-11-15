import { useQuery } from "@tanstack/react-query";
import type { UseQueryResult } from "@tanstack/react-query";
import type { BuildInfo } from "../../shared/types/build-info";
import { api } from "../api/client";
import { ApiFailure } from "../api/queries";
import type { NonOk } from "../api/result";

export const BUILD_POLL_MS = 30_000;
const MIN_POLL_MS = 1000;

/** `?buildPoll=<ms>` shortens the poll for the browser check; anything below 1 s is ignored. */
export function buildPollMs(search: string = globalThis.location?.search ?? ""): number {
  const raw = Number(new URLSearchParams(search).get("buildPoll"));
  return Number.isFinite(raw) && raw >= MIN_POLL_MS ? raw : BUILD_POLL_MS;
}

export async function fetchBuild(): Promise<BuildInfo> {
  const result = await api.getBuild();
  if (result.kind === "ok") {
    return result.body;
  }
  throw new ApiFailure(result as NonOk);
}

export function useBuild(pollMs: number = buildPollMs()): UseQueryResult<BuildInfo> {
  return useQuery({
    queryKey: ["build"],
    queryFn: fetchBuild,
    refetchInterval: () => (document.visibilityState === "hidden" ? false : pollMs),
    refetchOnWindowFocus: true,
  });
}
