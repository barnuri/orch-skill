import type { Selection } from "../lib/chat-logic";

let seed: Selection | null = null;

/** The harness, profile and model the next start page opens with (a group's newest chat). Used once. */
export function setStartSeed(next: Selection | null): void {
  seed = next;
}

export function takeStartSeed(): Selection | null {
  const out = seed;
  seed = null;
  return out;
}
