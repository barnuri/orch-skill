const PROFILE_HUES: readonly number[] = [212, 168, 278, 32, 8, 328, 188, 48, 142, 268];

/** Stable accent colour per profile name for graph nodes. */
export function profileAccent(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = PROFILE_HUES[hash % PROFILE_HUES.length];
  return `hsl(${hue} 58% 52%)`;
}

export function profileAccentSoft(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = PROFILE_HUES[hash % PROFILE_HUES.length];
  return `hsl(${hue} 42% 24%)`;
}
