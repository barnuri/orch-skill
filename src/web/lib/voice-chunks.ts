/** Transcribes the pieces of a long recording: in order, as they arrive, splitting a piece the hub refuses. */

export type TranscribeOutcome = { ok: true; text: string } | { ok: false; error: string };
export type ClipTranscriber = (clip: Blob, mime: string, language: string | null) => Promise<TranscribeOutcome>;

export interface ChunkInput {
  blob: Blob;
  mime: string;
  /** Length of the piece, to decide whether splitting it can help. */
  seconds?: number;
  /** Starts with audio the previous piece already ended with: drop the repeated words. */
  overlapped?: boolean;
}

/** Longest run of words that ends `prev` and starts `next` (case and punctuation ignored): the text said twice. */
export function mergeOverlap(prev: string, next: string): string {
  const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const a = prev.trim().split(/\s+/).filter((w) => w !== "");
  const b = next.trim().split(/\s+/).filter((w) => w !== "");
  const max = Math.min(a.length, b.length, 12);
  for (let n = max; n >= 2; n -= 1) {
    if (a.slice(a.length - n).every((w, i) => norm(w) === norm(b[i] ?? "") && norm(w) !== "")) {
      return b.slice(n).join(" ");
    }
  }
  return next.trim();
}

export interface ChunkTranscriberOptions {
  language: string | null;
  /** Called with the text of the longest finished prefix every time it grows. */
  onPartial?: (text: string) => void;
  concurrency?: number;
  /** Cuts a piece into two overlapping halves (browser: decode and re-encode as wav); null when it cannot. */
  split?: (blob: Blob) => Promise<[Blob, Blob] | null>;
  /** Pieces shorter than this are not split on failure; they are tried once more. */
  minSplitSeconds?: number;
}

/**
 * `add()` pieces while recording, `finish()` after the last one. Requests run `concurrency` at a time but the text is
 * joined in recording order, and `onPartial` only ever shows the finished prefix, so it never skips ahead.
 */
export class ChunkTranscriber {
  private readonly results: (string | null)[] = [];
  private readonly inputs: ChunkInput[] = [];
  private active = 0;
  private next = 0;
  private failure: string | null = null;
  private waiting: (() => void) | null = null;
  private closed = false;
  private shown = "";

  constructor(private readonly transcribe: ClipTranscriber, private readonly options: ChunkTranscriberOptions) {}

  add(input: ChunkInput): void {
    this.inputs.push(input);
    this.results.push(null);
    this.pump();
  }

  private pump(): void {
    const limit = this.options.concurrency ?? 2;
    while (this.active < limit && this.next < this.inputs.length && this.failure === null) {
      const index = this.next;
      this.next += 1;
      this.active += 1;
      void this.run(this.inputs[index] as ChunkInput).then((outcome) => {
        this.active -= 1;
        if (outcome.ok) {
          this.results[index] = outcome.text;
          this.publish();
        } else {
          this.failure ??= outcome.error;
        }
        this.pump();
        this.settle();
      });
    }
    this.settle();
  }

  private async run(input: ChunkInput, depth: number = 0): Promise<TranscribeOutcome> {
    const first = await this.transcribe(input.blob, input.mime, this.options.language);
    if (first.ok) return first;
    const minSplit = this.options.minSplitSeconds ?? 8;
    const long = (input.seconds ?? 0) >= minSplit;
    const halves = long && depth < 3 && this.options.split !== undefined ? await this.options.split(input.blob).catch(() => null) : null;
    if (halves === null) {
      // A short piece: one more try, for a hub that dropped the connection.
      return depth === 0 ? this.transcribe(input.blob, input.mime, this.options.language) : first;
    }
    const half = (input.seconds ?? 0) / 2 + 0.6;
    const left = await this.run({ blob: halves[0], mime: "audio/wav", seconds: half }, depth + 1);
    if (!left.ok) return left;
    const right = await this.run({ blob: halves[1], mime: "audio/wav", seconds: half }, depth + 1);
    if (!right.ok) return right;
    return { ok: true, text: [left.text, mergeOverlap(left.text, right.text)].filter((t) => t !== "").join(" ") };
  }

  private text(): string {
    let out = "";
    for (let i = 0; i < this.results.length; i += 1) {
      const part = this.results[i];
      if (part === null || part === undefined) break;
      const joined = this.inputs[i]?.overlapped === true ? mergeOverlap(out, part) : part.trim();
      out = [out, joined].filter((t) => t !== "").join(" ");
    }
    return out;
  }

  private publish(): void {
    const text = this.text();
    if (text !== this.shown) {
      this.shown = text;
      this.options.onPartial?.(text);
    }
  }

  private settle(): void {
    if (this.waiting !== null && (this.failure !== null || (this.closed && this.active === 0 && this.next >= this.inputs.length))) {
      const w = this.waiting;
      this.waiting = null;
      w();
    }
  }

  /** Resolves when every added piece is done, or with the first error. */
  finish(): Promise<TranscribeOutcome> {
    this.closed = true;
    return new Promise((resolve) => {
      const done = (): void => {
        if (this.failure !== null) {
          resolve({ ok: false, error: this.failure });
        } else {
          resolve({ ok: true, text: this.text() });
        }
      };
      this.waiting = done;
      if (this.failure !== null || (this.active === 0 && this.next >= this.inputs.length)) {
        this.waiting = null;
        done();
      }
    });
  }
}
