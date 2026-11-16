/**
 * What the conversation mode says aloud: markdown reduced to speech, split into sentences while the reply streams.
 * Never spoken: code (said as "code block"), tool output, URLs, long file paths, markdown marks, table rows.
 * A long list is summarised after its first items.
 */
import { detectLanguage } from "./voice-logic";

export interface Sentence {
  /** Position in the reply: stable while the reply grows. */
  index: number;
  text: string;
  /** BCP-47 tag chosen for this sentence alone, so a Hebrew reply with an English sentence is read by two voices. */
  lang: string;
}

const LIST_ITEMS_SPOKEN = 4;
const MIN_SENTENCE = 12;

const CODE_BLOCK: Record<string, string> = { he: "בלוק קוד", en: "code block" };
const MORE_ITEMS = (n: number, lang: string): string => (lang.startsWith("he") ? `ועוד ${n} פריטים` : `and ${n} more items`);

const baseOf = (lang: string): string => (lang.split("-")[0] ?? "en").toLowerCase();

/** Digits, money and percent read the way a person says them; Hebrew gets Hebrew currency words. */
export function speakNumbers(text: string, lang: string): string {
  const he = baseOf(lang) === "he";
  let out = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  out = out.replace(/(?:₪\s?(\d+(?:\.\d+)?))|(?:(\d+(?:\.\d+)?)\s?₪)/g, (_m, a: string | undefined, b: string | undefined) => `${a ?? b} ${he ? "שקלים" : "shekels"}`);
  out = out.replace(/\$\s?(\d+(?:\.\d+)?)/g, (_m, n: string) => `${n} ${he ? "דולר" : "dollars"}`);
  out = out.replace(/€\s?(\d+(?:\.\d+)?)/g, (_m, n: string) => `${n} ${he ? "יורו" : "euros"}`);
  out = out.replace(/(\d)\s?%/g, (_m, n: string) => `${n} ${he ? "אחוז" : "percent"}`);
  return out;
}

const PATH = /(?:~|\.{1,2})?(?:\/[\w.@+-]+){3,}\/?|[A-Za-z]:\\(?:[\w.-]+\\){2,}[\w.-]*/g;

/** One line of markdown as plain speech ("" when nothing is worth saying). */
export function cleanInline(line: string, lang: string): string {
  const he = baseOf(lang) === "he";
  const text = line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/`([^`]*)`/g, (_m, code: string) => (code.length > 28 || /[{};=()<>]/.test(code) ? " " : code))
    .replace(PATH, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[*_~#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return speakNumbers(text, he ? "he" : lang);
}

/** Sentences of a plain-text line: split after . ! ? … followed by space; short pieces ride with the next one. */
export function sentencesOf(text: string): string[] {
  const raw = text.split(/(?<=[.!?…。！？]["')\]]?)\s+/).map((s) => s.trim()).filter((s) => s !== "");
  const out: string[] = [];
  let carry = "";
  for (const piece of raw) {
    const joined = carry === "" ? piece : `${carry} ${piece}`;
    if (joined.length < MIN_SENTENCE) {
      carry = joined;
    } else {
      out.push(joined);
      carry = "";
    }
  }
  if (carry !== "") out.push(carry);
  return out;
}

const FENCE = /^\s*(```|~~~)/;
const LIST = /^\s{0,6}(?:[-*+•]|\d+[.)])\s+(.*)$/;
const TABLE = /^\s*\|.*\|\s*$|^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/;

/**
 * Incremental speech from a growing reply: `push(content, final)` returns the sentences that became ready since the
 * last call, never one twice and never one that could still change. Sentences come out as soon as they end, even
 * inside a long paragraph still streaming.
 */
export class SpeechStream {
  private lineDone = 0;
  private inFence = false;
  private listItems = 0;
  private listSkipped = 0;
  private emitted = 0;
  private partialEmitted = 0;
  private lastLang: string;

  constructor(private readonly fallbackLang: string) {
    this.lastLang = fallbackLang;
  }

  private tag(text: string): string {
    const lang = detectLanguage(text, this.lastLang === "" ? this.fallbackLang : this.lastLang);
    this.lastLang = lang;
    return lang;
  }

  private make(text: string, out: Sentence[]): void {
    if (text.trim() === "") return;
    out.push({ index: this.emitted, text, lang: this.tag(text) });
    this.emitted += 1;
  }

  private endList(out: Sentence[]): void {
    if (this.listSkipped > 0) this.make(MORE_ITEMS(this.listSkipped, this.lastLang), out);
    this.listItems = 0;
    this.listSkipped = 0;
  }

  /** Handles one finished line. */
  private line(raw: string, out: Sentence[], alreadyEmitted: number): void {
    if (FENCE.test(raw)) {
      if (this.inFence) {
        this.inFence = false;
        this.make(CODE_BLOCK[baseOf(this.lastLang)] ?? CODE_BLOCK.en!, out);
      } else {
        this.inFence = true;
      }
      return;
    }
    if (this.inFence || TABLE.test(raw)) return;
    const item = LIST.exec(raw);
    if (item === null) {
      if (raw.trim() !== "") this.endList(out);
    } else {
      this.listItems += 1;
      if (this.listItems > LIST_ITEMS_SPOKEN) {
        this.listSkipped += 1;
        return;
      }
    }
    const text = cleanInline(item === null ? raw : (item[1] ?? ""), this.lastLang);
    sentencesOf(text).slice(alreadyEmitted).forEach((s) => this.make(s, out));
  }

  push(content: string, final: boolean): Sentence[] {
    const out: Sentence[] = [];
    const lines = content.split("\n");
    const completeCount = final ? lines.length : lines.length - 1;
    while (this.lineDone < completeCount) {
      this.line(lines[this.lineDone] ?? "", out, this.partialEmitted);
      this.partialEmitted = 0;
      this.lineDone += 1;
    }
    if (final) {
      this.endList(out);
      return out;
    }
    const partial = lines[lines.length - 1] ?? "";
    if (!this.inFence && !FENCE.test(partial) && !TABLE.test(partial) && !LIST.test(partial)) {
      const pieces = sentencesOf(cleanInline(partial, this.lastLang));
      // The last piece may still grow.
      pieces.slice(this.partialEmitted, Math.max(this.partialEmitted, pieces.length - 1)).forEach((s) => this.make(s, out));
      this.partialEmitted = Math.max(this.partialEmitted, pieces.length - 1);
    }
    return out;
  }
}

/** The whole reply at once (a reply that was already complete when the mode saw it). */
export function speechOf(content: string, fallbackLang: string): Sentence[] {
  return new SpeechStream(fallbackLang).push(content, true);
}

/** The text of a question card as speech: the question, then its options numbered. */
export function questionSpeech(question: string, options: readonly string[], lang: string): string {
  const he = baseOf(lang) === "he";
  const q = cleanInline(question, lang);
  if (options.length === 0) return q;
  const list = options.map((o, i) => `${i + 1}, ${cleanInline(o, lang)}`).join(". ");
  return `${q} ${he ? "האפשרויות" : "The options are"}: ${list}.`;
}
