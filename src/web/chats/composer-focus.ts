const WINDOW_MS = 10_000;
let requestedAt = 0;

/** Ask the next composer that mounts to take focus (a chat was just created from the sidebar). */
export function requestComposerFocus(): void {
  requestedAt = Date.now();
}

/** True once per request, and only shortly after it was made. */
export function takeComposerFocus(): boolean {
  const fresh = requestedAt !== 0 && Date.now() - requestedAt < WINDOW_MS;
  requestedAt = 0;
  return fresh;
}
