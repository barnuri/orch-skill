// Hues spread around the wheel, ordered so neighbouring palette entries stay far apart.
const PROFILE_HUES: readonly number[] = [212, 32, 168, 328, 96, 268, 8, 188, 48, 288, 142, 358];

function hashOf(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function hueAt(index: number): number {
  return PROFILE_HUES[index % PROFILE_HUES.length] ?? PROFILE_HUES[0] ?? 212;
}

function accentFor(hue: number): string {
  return `hsl(${hue} 58% 52%)`;
}

function softFor(hue: number): string {
  return `hsl(${hue} 42% 24%)`;
}

export interface ProfilePalette {
  accent: (name: string) => string;
  soft: (name: string) => string;
}

/**
 * Assigns each profile a hue by its **index** in the run's own sorted profile list, so no two
 * profiles in one graph can share a colour. Hashing the name (the previous approach) collides:
 * `claude-llm-hub` and `cursor-llm-hub` both landed on hue 188, drawing two different lanes in
 * the same colour. Beyond the palette length the wheel repeats — unavoidable, and far past the
 * point where a reader could tell hues apart anyway.
 */
export function profilePalette(names: readonly string[]): ProfilePalette {
  const hues = new Map<string, number>();
  const sorted = [...new Set(names)].sort();
  sorted.forEach((name, index) => {
    hues.set(name, hueAt(index));
  });
  const hueOf = (name: string): number => hues.get(name) ?? hueAt(hashOf(name));
  return {
    accent: (name: string): string => accentFor(hueOf(name)),
    soft: (name: string): string => softFor(hueOf(name)),
  };
}

/** Stable colour for one profile with no run context (legends, rows outside a graph). */
export function profileAccent(name: string): string {
  return accentFor(hueAt(hashOf(name)));
}

export function profileAccentSoft(name: string): string {
  return softFor(hueAt(hashOf(name)));
}
