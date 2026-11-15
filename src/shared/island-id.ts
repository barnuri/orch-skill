/**
 * The element id an embedded API document gets in an emitted artifact. Shared because both sides
 * of the contract need it: the emitter writes these ids, the dashboard reads them. Bun-free, like
 * everything else under `shared/`.
 */
export const ISLAND_ID_PREFIX: string = "orch-island-";

export function islandElementId(name: string): string {
  return `${ISLAND_ID_PREFIX}${name}`;
}
