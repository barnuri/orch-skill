import type { ArtifactInfo, ArtifactSettings, ArtifactVersion } from "../../../shared/artifacts";
import { authHeaders } from "../../api/chats";
import { API_BASE } from "../../lib/constants";

const q = encodeURIComponent;
const base = (chatId: string, name: string): string => `${API_BASE}/chats/${q(chatId)}/artifacts/${q(name)}`;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `request failed (${res.status})`;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // keep the status text
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const call = (url: string, method = "GET", body?: unknown): Promise<Response> =>
  fetch(url, { method, headers: { ...authHeaders(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

export const artifactsApi = {
  list: (chatId: string): Promise<{ items: ArtifactInfo[]; dir: string }> => call(`${API_BASE}/chats/${q(chatId)}/artifacts`).then((r) => json(r)),
  versions: (chatId: string, name: string): Promise<{ items: ArtifactVersion[] }> => call(`${base(chatId, name)}/versions`).then((r) => json(r)),
  /** The bytes of the current file or of one version. */
  content: async (chatId: string, name: string, version: number | null): Promise<Blob> => {
    const res = await call(`${base(chatId, name)}/content?preview=1${version === null ? "" : `&version=${version}`}`);
    if (!res.ok) {
      await json(res);
    }
    return res.blob();
  },
  save: (chatId: string, name: string, content: string, baseHash: string): Promise<unknown> => call(base(chatId, name), "PUT", { content, base_hash: baseHash }).then((r) => json(r)),
  restore: (chatId: string, name: string, version: number): Promise<unknown> => call(`${base(chatId, name)}/restore`, "POST", { version }).then((r) => json(r)),
  view: (chatId: string, name: string, version: number | null): Promise<{ url: string }> => call(`${base(chatId, name)}/view`, "POST", version === null ? {} : { version }).then((r) => json(r)),
  settings: (): Promise<ArtifactSettings> => call(`${API_BASE}/artifact-settings`).then((r) => json(r)),
  saveSettings: (s: ArtifactSettings): Promise<ArtifactSettings> => call(`${API_BASE}/artifact-settings`, "PUT", s).then((r) => json(r)),
};
