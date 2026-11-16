/**
 * Speaks sentences one after another with the browser's speechSynthesis, each in the voice for its own language.
 * It keeps its own queue (the engine's queue cannot be trusted to stop at once on every browser), so `stop()` is immediate.
 */
import { pickVoice, speechChunks } from "../lib/voice-logic";
import type { VoiceLike } from "../lib/voice-logic";
import type { Sentence } from "../lib/speech-text";

export interface UtteranceLike {
  text: string;
  lang: string;
  voice: unknown;
  rate: number;
  onend: (() => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

export interface SynthLike {
  speak: (u: UtteranceLike) => void;
  cancel: () => void;
  getVoices: () => (VoiceLike & { voiceURI?: string })[];
  paused?: boolean;
  resume?: () => void;
}

export interface TtsQueueOptions {
  synth: SynthLike;
  makeUtterance: (text: string) => UtteranceLike;
  /** voiceURI chosen in the settings, per language base (`he`, `en`). */
  voiceFor?: (langBase: string) => string | undefined;
  rate?: () => number;
  /** The sentence being spoken, or null when the queue went idle. */
  onActive?: (sentence: Sentence | null) => void;
  /** First sentence of a burst started: the mode turns to Speaking. */
  onStart?: () => void;
  onIdle?: () => void;
  /** Said once per language when no installed voice speaks it. */
  onNoVoice?: (lang: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

const baseOf = (lang: string): string => (lang.split("-")[0] ?? "").toLowerCase().replace(/^iw$/, "he");

export class TtsQueue {
  private queue: Sentence[] = [];
  private running = false;
  private token = 0;
  private current: (() => void) | null = null;
  private warned = new Set<string>();

  constructor(private readonly o: TtsQueueOptions) {}

  get speaking(): boolean {
    return this.running || this.queue.length > 0;
  }

  enqueue(sentence: Sentence): void {
    this.queue.push(sentence);
    if (!this.running) void this.drain();
  }

  /** Silences the engine and forgets everything queued, at once. */
  stop(): void {
    this.token += 1;
    this.queue = [];
    this.o.synth.cancel();
    const cur = this.current;
    this.current = null;
    cur?.();
    if (this.running) {
      this.running = false;
      this.o.onActive?.(null);
    }
  }

  private pick(lang: string): { voice: (VoiceLike & { voiceURI?: string }) | null } {
    const voices = this.o.synth.getVoices();
    const want = this.o.voiceFor?.(baseOf(lang));
    const chosen = want === undefined ? undefined : voices.find((v) => v.voiceURI === want || v.name === want);
    const voice = chosen ?? pickVoice(voices, lang);
    if (voice === null && voices.length > 0 && !this.warned.has(baseOf(lang))) {
      this.warned.add(baseOf(lang));
      this.o.onNoVoice?.(lang);
    }
    return { voice };
  }

  private say(text: string, lang: string, token: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const u = this.o.makeUtterance(text);
      const { voice } = this.pick(lang);
      u.lang = voice?.lang ?? lang;
      if (voice !== null) u.voice = voice;
      u.rate = this.o.rate?.() ?? 1;
      const set = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
      const clear = this.o.clearTimer ?? ((id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>));
      let timer: unknown = null;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (timer !== null) clear(timer);
        if (this.current === finish) this.current = null;
        resolve();
      };
      this.current = finish;
      u.onend = finish;
      u.onerror = finish;
      // Some engines end neither with onend nor onerror: give up after a generous estimate so the loop cannot hang.
      timer = set(finish, Math.max(8000, (text.length * 120) / Math.max(0.5, u.rate)));
      if (token !== this.token) {
        finish();
        return;
      }
      this.o.synth.speak(u);
      if (this.o.synth.paused) this.o.synth.resume?.();
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    const token = this.token;
    let first = true;
    while (this.queue.length > 0 && token === this.token) {
      const next = this.queue.shift() as Sentence;
      this.o.onActive?.(next);
      if (first) {
        first = false;
        this.o.onStart?.();
      }
      for (const part of speechChunks(next.text)) {
        if (token !== this.token) return;
        await this.say(part, next.lang, token);
      }
    }
    if (token !== this.token) return;
    this.running = false;
    this.o.onActive?.(null);
    this.o.onIdle?.();
  }
}
