import { profileEnvSource } from "./options";

/** Header the claude adapter sends to the hub; the hub files the request under this worker id. */
export const HUB_WORKER_HEADER = "x-llm-hub-smart-auto-worker";

/** Worker id of one reply: `chat/<chat id>/<message id>`. */
export function hubWorkerId(chatId: string, messageId: string): string {
  return `chat/${chatId}/${messageId}`;
}

/** The value of ANTHROPIC_CUSTOM_HEADERS for one turn, keeping any header the profile already sets. */
export function hubWorkerHeaders(chatId: string, messageId: string, existing: string | undefined): string {
  const line = `${HUB_WORKER_HEADER}: ${hubWorkerId(chatId, messageId)}`;
  return existing === undefined || existing.trim() === "" ? line : `${existing.trimEnd()}\n${line}`;
}

export interface HubAdmin { base: string; apiKey: string }

/** Hub root (without `/v1`) and key, from the process env then `<home>/env`. Null when either is unset. */
export function hubAdmin(home: string): HubAdmin | null {
  const vars = profileEnvSource(home, "");
  const base = (vars.LLM_HUB_V1_URL ?? vars.LLM_HUB_BASE_URL ?? "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  const apiKey = (vars.LLM_HUB_API_KEY ?? vars.LLM_HUB_KEY ?? "").trim();
  return base === "" || apiKey === "" ? null : { base, apiKey };
}

export interface HubSelection { effort: string | null; model: string | null }

/** Reads the newest history entry from a hub answer shaped as one object, an array, or `{entries|history|items: [...]}`. */
export function selectionFrom(body: unknown): HubSelection | null {
  let entry: unknown = body;
  if (Array.isArray(entry)) {
    entry = entry[entry.length - 1];
  } else if (typeof entry === "object" && entry !== null) {
    const list = (["entries", "history", "items"] as const).map((key) => (entry as Record<string, unknown>)[key]).find(Array.isArray);
    if (list !== undefined) {
      entry = list[list.length - 1];
    }
  }
  if (typeof entry !== "object" || entry === null) {
    return null;
  }
  const { selected_effort: effort, selected_model: model } = entry as Record<string, unknown>;
  const selection = {
    effort: typeof effort === "string" && effort !== "" ? effort : null,
    model: typeof model === "string" && model !== "" ? model : null,
  };
  return selection.effort === null && selection.model === null ? null : selection;
}

/** Asks the hub what effort and model a reply used. Null when the hub cannot be queried or has no entry. */
export async function hubSelection(admin: HubAdmin, worker: string, fetchFn: typeof fetch = fetch, timeoutMs = 3000): Promise<HubSelection | null> {
  try {
    const res = await fetchFn(`${admin.base}/api/smart-auto/history?worker=${encodeURIComponent(worker)}`, {
      headers: { Authorization: `Bearer ${admin.apiKey}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return null;
    }
    return selectionFrom(await res.json());
  } catch {
    return null;
  }
}
