/** Small browser-environment helpers of the conversation mode, written to be tested with fakes. */

/** One sentence when voice cannot work on this page's origin, else null. */
export function voiceOriginProblem(env: { isSecureContext: boolean; protocol: string; hostname: string; hasMediaDevices: boolean }): string | null {
  if (env.isSecureContext && env.hasMediaDevices) return null;
  if (env.protocol === "http:" && !env.isSecureContext) {
    return "Voice needs https or localhost: open this page over https (see the /trust page to set up the certificate) or use localhost.";
  }
  return "This browser has no microphone access here: use a current Chrome, Edge, Firefox or Safari.";
}

export interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener?: (type: "release", listener: () => void) => void;
}

export interface WakeLockHost {
  wakeLock?: { request: (type: "screen") => Promise<WakeLockSentinelLike> };
}

/** Keeps the screen on while the mode is open. Never throws: a browser without the API, or a denied request, is not an error. */
export class ScreenAwake {
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;

  constructor(private readonly host: WakeLockHost) {}

  async acquire(): Promise<boolean> {
    this.wanted = true;
    if (this.host.wakeLock === undefined) return false;
    try {
      this.sentinel = await this.host.wakeLock.request("screen");
      if (!this.wanted) await this.release();
      return this.sentinel !== null;
    } catch {
      return false;
    }
  }

  /** Browsers drop the lock when the tab is hidden: call this when it becomes visible again. */
  async reacquire(): Promise<void> {
    if (this.wanted && this.sentinel === null) await this.acquire();
  }

  async release(): Promise<void> {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    try {
      await s?.release();
    } catch {
      // already released
    }
  }

  get held(): boolean {
    return this.sentinel !== null;
  }
}

export interface SpokenOption {
  label: string;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, first: 1, two: 2, second: 2, three: 3, third: 3, four: 4, fourth: 4, five: 5, fifth: 5, six: 6, sixth: 6,
  אחד: 1, אחת: 1, ראשון: 1, ראשונה: 1, שתיים: 2, שניים: 2, שתי: 2, שני: 2, שנייה: 2, שלוש: 3, שלושה: 3, שלישי: 3, שלישית: 3, ארבע: 4, ארבעה: 4, רביעי: 4, חמש: 5, חמישי: 5, שש: 6, שישי: 6,
};

const norm = (t: string): string => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/**
 * Which option a spoken answer means: its number ("two", "option 2", "השני"), or its label said in full or by its words.
 * Returns the label, or null when nothing fits (the caller then offers the typed answer or asks again).
 */
export function matchSpokenOption(spoken: string, options: readonly SpokenOption[]): string | null {
  const text = norm(spoken);
  if (text === "" || options.length === 0) return null;
  const exact = options.find((o) => norm(o.label) === text);
  if (exact !== undefined) return exact.label;
  const contained = options.filter((o) => norm(o.label) !== "" && text.includes(norm(o.label)));
  if (contained.length === 1) return (contained[0] as SpokenOption).label;
  const words = text.split(" ");
  for (const w of words) {
    const n = /^\d+$/.test(w) ? Number(w) : (WORD_NUMBERS[w] ?? WORD_NUMBERS[w.replace(/^ה/, "")]);
    if (n !== undefined && n >= 1 && n <= options.length) return (options[n - 1] as SpokenOption).label;
  }
  const scored = options.map((o) => ({ o, hits: norm(o.label).split(" ").filter((w) => w.length > 2 && words.includes(w)).length })).filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits);
  if (scored.length === 1 || (scored.length > 1 && (scored[0] as { hits: number }).hits > (scored[1] as { hits: number }).hits)) return (scored[0] as { o: SpokenOption }).o.label;
  return null;
}
