import { resolve } from "node:path";

const SNAPSHOT_DIR: string = resolve(import.meta.dir, "../snapshot");

export const CHAT_ICON_LIGHT: string = resolve(SNAPSHOT_DIR, "favicon.svg");
export const CHAT_ICON_DARK: string = resolve(SNAPSHOT_DIR, "favicon-dark.svg");

export function chatIconResponse(path: string): Response {
  return new Response(Bun.file(path), { headers: { "content-type": "image/svg+xml", "cache-control": "no-cache" } });
}
