// The agent configs that chats inherit are written in English, so a model with no hint answers in English even
// when the user writes Hebrew. A message in another script gets one trailing line that names the language to use.
const SCRIPTS: readonly { name: string; re: RegExp }[] = [
  { name: "Hebrew", re: /[\u0590-\u05FF]/g },
  { name: "Arabic", re: /[\u0600-\u06FF]/g },
  { name: "Russian", re: /[\u0400-\u04FF]/g },
  { name: "Greek", re: /[\u0370-\u03FF]/g },
  { name: "Chinese", re: /[\u4E00-\u9FFF]/g },
  { name: "Japanese", re: /[\u3040-\u30FF]/g },
  { name: "Korean", re: /[\uAC00-\uD7AF]/g },
];

/** The language of the message when a non-Latin script holds most of its letters, else null. */
export function detectLanguage(text: string): string | null {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return null;
  let best: { name: string; n: number } | null = null;
  for (const s of SCRIPTS) {
    const n = (text.match(s.re) ?? []).length;
    if (n > 0 && (best === null || n > best.n)) best = { name: s.name, n };
  }
  return best !== null && best.n * 2 >= letters ? best.name : null;
}

/** The prompt sent to the agent: the user's text plus a reply-language line when it is not Latin script. */
export function withLanguageHint(text: string): string {
  const lang = detectLanguage(text);
  return lang === null ? text : `${text}\n\n[Reply in ${lang}, the language of this message. Keep code, commands and file names as they are.]`;
}
