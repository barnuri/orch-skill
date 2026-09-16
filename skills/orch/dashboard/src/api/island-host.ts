/**
 * The one DOM capability the island reader needs. Declared as its own interface so the reader
 * can be exercised without a `document` — `bun test` has no DOM, and the skill takes no
 * dependency that would supply one.
 */
export interface IslandHost {
  getElementById(elementId: string): { readonly textContent: string | null } | null;
}
