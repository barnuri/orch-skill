// `model sync-hub`: reads the llm-hub model list (GET <LLM_HUB_URL>/v1/models) and adds the chat-capable
// models to the catalog and to the opencode provider config of every profile that allows any model.
// Writes only through profilesCommit, like the other profile subcommands.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { orchHome, paths } from "../state/home.ts";
import { ensureHome, profilesCommit } from "../state/profiles.ts";

const err = (s: string, code: number): number => (process.stderr.write(s), code);
const out = (s: string): number => (s !== "" && process.stdout.write(s), 0);

export const SYNC_HUB_USAGE = "dispatch.ts model sync-hub\n";

// Hub ids that are not chat models (embeddings, speech, video, safety classifiers, image generation).
const NON_CHAT = /embed|whisper|parakeet|ivrit|marengo|pegasus|rerank|tts|transcri|moderat|safeguard|image|dall|sora|flux|stable-diffusion|canvas|reel/i;
const CONTEXT = 200000;
const OUTPUT = 32768;

export function isChatModel(id: string): boolean {
  return !NON_CHAT.test(id);
}

// The hub's own name for a model: opencode's `-m hub/<rest>` sends <rest> to the hub.
export function hubSlug(id: string): string {
  return id.startsWith("hub/") ? id : `hub/${id}`;
}

// The catalog key for a hub model: "hub-" plus the slug, with characters outside [A-Za-z0-9._-] turned to "-".
export function hubCatalogKey(slug: string): string {
  return `hub-${slug.replace(/^hub\//, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`;
}

function hubEnv(home: string): { url: string; key: string } | null {
  let text: string;
  try {
    text = readFileSync(join(home, "env"), "utf8");
  } catch {
    return null;
  }
  const read = (name: string): string => {
    const line = text.split("\n").find((l) => l.startsWith(`${name}=`));
    return line === undefined ? "" : line.slice(name.length + 1).trim();
  };
  const url = read("LLM_HUB_URL").replace(/\/+$/, "");
  return url === "" ? null : { url, key: read("LLM_HUB_KEY") };
}

async function fetchHubIds(url: string, key: string): Promise<string[]> {
  const res = await fetch(`${url}/v1/models`, {
    headers: key === "" ? {} : { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`hub answered HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
  return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
}

export async function modelSyncHub(args: string[]): Promise<number> {
  if (args.length > 0) return err(SYNC_HUB_USAGE, 2);
  const home = orchHome();
  if (!(await ensureHome(home))) return 1;
  const env = hubEnv(home);
  if (env === null) return err("model sync-hub: LLM_HUB_URL is not set in the orch env file\n", 1);
  let ids: string[];
  try {
    ids = await fetchHubIds(env.url, env.key);
  } catch (e) {
    return err(`model sync-hub: ${(e as Error).message}\n`, 1);
  }
  const chat = [...new Set(ids.filter(isChatModel))].sort();
  const doc: any = await Bun.file(paths.profiles(home)).json();
  doc.models ??= {};

  let added = 0;
  for (const id of chat) {
    const slug = hubSlug(id);
    const key = hubCatalogKey(slug);
    if (doc.models[key] === undefined) {
      doc.models[key] = { slug, harnesses: ["opencode"], description: `llm-hub ${id}`, tags: ["hub", "hub-discovered"] };
      added++;
    }
  }

  let profilesUpdated = 0;
  let providerAdded = 0;
  for (const p of Object.values<any>(doc.profiles ?? {})) {
    if (!Array.isArray(p.allowed_models) || !p.allowed_models.includes("*")) continue;
    const raw = p.env?.OPENCODE_CONFIG_CONTENT;
    if (typeof raw !== "string") continue;
    let cfg: any;
    try {
      cfg = JSON.parse(raw);
    } catch {
      continue;
    }
    const hub = cfg?.provider?.hub;
    if (hub?.options?.baseURL !== "{env:LLM_HUB_V1_URL}") continue;
    hub.models ??= {};
    let n = 0;
    for (const id of chat) {
      const modelKey = hubSlug(id).slice("hub/".length);
      if (hub.models[modelKey] === undefined) {
        hub.models[modelKey] = { id, limit: { context: CONTEXT, output: OUTPUT } };
        n++;
      }
    }
    if (n > 0) {
      p.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(cfg);
      providerAdded += n;
      profilesUpdated++;
    }
  }

  profilesCommit(home, doc);
  return out(
    `model sync-hub: ${ids.length} hub models, ${chat.length} chat-capable, ${added} new catalog entries, ` +
      `${providerAdded} provider entries added to ${profilesUpdated} profiles\n`,
  );
}
