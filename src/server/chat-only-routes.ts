import { resolve } from "node:path";

const SNAPSHOT_DIR: string = resolve(import.meta.dir, "../snapshot");

export const CHAT_ICON_LIGHT: string = resolve(SNAPSHOT_DIR, "favicon.svg");
export const CHAT_ICON_DARK: string = resolve(SNAPSHOT_DIR, "favicon-dark.svg");

// One source of truth: the same file the chat page links as its manifest (Bun bundles it for the <link>).
const MANIFEST_PATH: string = resolve(import.meta.dir, "../web/chat.webmanifest");

export function chatManifestResponse(): Response {
  return new Response(Bun.file(MANIFEST_PATH), { headers: { "content-type": "application/manifest+json", "cache-control": "no-cache" } });
}

export function chatIconResponse(path: string): Response {
  return new Response(Bun.file(path), { headers: { "content-type": "image/svg+xml", "cache-control": "no-cache" } });
}
