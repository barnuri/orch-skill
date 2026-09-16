import { islandElementId } from "../../../shared/island-id";
import type { IslandHost } from "./island-host";

// A published artifact has no network access, so `dispatch.sh artifact` embeds each API document
// the dashboard would otherwise fetch as a `<script type="application/json">` block. The blocks
// are data, not script, so they render under the artifact CSP's `script-src` unchanged.

/**
 * The embedded document called `name`, or null when this page carries no such island — which is
 * the normal case for the live dashboard, where every read goes to the server instead. Malformed
 * JSON also yields null: a snapshot with one corrupt island should degrade to "no data" for that
 * document, not break the page.
 */
export function readDataIsland<T>(name: string, host: IslandHost): T | null {
  const element = host.getElementById(islandElementId(name));
  if (element === null) {
    return null;
  }
  const text = element.textContent;
  if (text === null || text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    if (err instanceof Error) {
      return null;
    }
    throw err;
  }
}

/** Whether this page is an emitted snapshot at all — true once any island is present. */
export function hasDataIslands(names: readonly string[], host: IslandHost): boolean {
  return names.some((name) => host.getElementById(islandElementId(name)) !== null);
}
