/**
 * Energy voice-activity detector for the hands-free loop. Fed (rms level, time in ms) samples it:
 *  - calibrates a noise floor from the first `calibrateMs` (the quietest quarter of the samples, so a user who starts
 *    talking at once does not raise the floor),
 *  - starts speech above `floor * startFactor` and counts anything above the lower `floor * stopFactor` as still speaking
 *    (hysteresis: a soft word or a breath inside a sentence is not silence),
 *  - ends speech only after `endSilenceMs` of continuous quiet that follows speech, and never before anyone spoke.
 */

export interface VadOptions {
  /** Quiet time after speech that ends the utterance. */
  endSilenceMs: number;
  /** Speech must stay above the start threshold this long to count (a click or cough does not). */
  minSpeechMs: number;
  calibrateMs: number;
  startFactor: number;
  stopFactor: number;
  /** Absolute floors of the two thresholds, for a dead-quiet room whose floor measures near 0. */
  minStart: number;
  minStop: number;
}

export const END_SILENCE_MIN_MS = 800;
export const END_SILENCE_MAX_MS = 4000;
export const END_SILENCE_DEFAULT_MS = 1800;

export const DEFAULT_VAD: VadOptions = { endSilenceMs: END_SILENCE_DEFAULT_MS, minSpeechMs: 200, calibrateMs: 500, startFactor: 3, stopFactor: 1.6, minStart: 0.015, minStop: 0.007 };

export function clampEndSilence(ms: number): number {
  if (!Number.isFinite(ms)) return END_SILENCE_DEFAULT_MS;
  return Math.min(END_SILENCE_MAX_MS, Math.max(END_SILENCE_MIN_MS, Math.round(ms)));
}

export type VadEvent = "speech-start" | "speech-end" | null;

export class EnergyVad {
  private readonly o: VadOptions;
  private floor = 0;
  private calibrated = false;
  private samples: number[] = [];
  private firstAt: number | null = null;
  private loudSince: number | null = null;
  private lastLoudAt: number | null = null;
  private quietSince: number | null = null;
  private started = false;
  private ended = false;

  constructor(options: Partial<VadOptions> = {}) {
    this.o = { ...DEFAULT_VAD, ...options, endSilenceMs: clampEndSilence(options.endSilenceMs ?? DEFAULT_VAD.endSilenceMs) };
  }

  get heardSpeech(): boolean {
    return this.started;
  }

  get calibrating(): boolean {
    return !this.calibrated;
  }

  get noiseFloor(): number {
    return this.floor;
  }

  get startThreshold(): number {
    return Math.max(this.o.minStart, this.floor * this.o.startFactor);
  }

  get stopThreshold(): number {
    return Math.max(this.o.minStop, this.floor * this.o.stopFactor);
  }

  /** True while the input is in the pause part of the signal: the place to cut a long recording. */
  get quiet(): boolean {
    return this.quietSince !== null || !this.started;
  }

  private calibrate(level: number, now: number): void {
    this.firstAt ??= now;
    this.samples.push(level);
    if (now - this.firstAt < this.o.calibrateMs) return;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const lower = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 4)));
    this.floor = lower.reduce((a, b) => a + b, 0) / lower.length;
    this.calibrated = true;
    this.samples = [];
  }

  push(level: number, now: number): VadEvent {
    if (this.ended) return null;
    if (!this.calibrated) {
      this.calibrate(level, now);
      // Speech heard while calibrating still counts once the floor is known, so the first word is not lost.
      if (!this.calibrated) return null;
    }
    if (!this.started) {
      if (level >= this.startThreshold) {
        this.loudSince ??= now;
        this.lastLoudAt = now;
        if (now - this.loudSince >= this.o.minSpeechMs) {
          this.started = true;
          this.quietSince = null;
          return "speech-start";
        }
      } else if (this.loudSince !== null && this.lastLoudAt !== null && now - this.lastLoudAt > 300) {
        this.loudSince = null;
      }
      if (level < this.stopThreshold) this.floor = this.floor * 0.97 + level * 0.03;
      return null;
    }
    if (level >= this.stopThreshold) {
      this.quietSince = null;
      return null;
    }
    this.quietSince ??= now;
    if (now - this.quietSince >= this.o.endSilenceMs) {
      this.ended = true;
      return "speech-end";
    }
    return null;
  }
}

/**
 * When a long recording is cut into pieces, ported from the voice-notes app's SpeechChunker (web/public/shared/speech-chunker.js):
 * never before `minMs`, then at a sentence pause (`gapMs` quiet), after `longMs` already at a word gap, and by force at `maxMs`.
 * The cut itself loses nothing: the next recorder starts before the old one stops.
 */
export interface SegmentOptions {
  minMs: number;
  gapMs: number;
  longMs: number;
  wordGapMs: number;
  maxMs: number;
}

export const DEFAULT_SEGMENT: SegmentOptions = { minMs: 5_000, gapMs: 700, longMs: 12_000, wordGapMs: 250, maxMs: 60_000 };

export type SegmentCut = "none" | "pause" | "forced";

export class SegmentPolicy {
  private readonly o: SegmentOptions;
  private startedAt = 0;
  private lastLoudAt = 0;
  hasSpeech = false;

  constructor(options: Partial<SegmentOptions> = {}) {
    this.o = { ...DEFAULT_SEGMENT, ...options };
  }

  reset(now: number): void {
    this.startedAt = now;
    this.lastLoudAt = now;
    this.hasSpeech = false;
  }

  /** `loud`: this frame is above the VAD's stop threshold. */
  observe(loud: boolean, now: number): SegmentCut {
    if (loud) {
      this.hasSpeech = true;
      this.lastLoudAt = now;
    }
    const age = now - this.startedAt;
    if (age >= this.o.maxMs) return "forced";
    if (!this.hasSpeech || age < this.o.minMs) return "none";
    const quietFor = now - this.lastLoudAt;
    return quietFor >= this.o.gapMs || (age >= this.o.longMs && quietFor >= this.o.wordGapMs) ? "pause" : "none";
  }
}
