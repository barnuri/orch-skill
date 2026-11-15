export type ParseResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Deepest `{`/`[` nesting accepted. The documents this guards are a few levels
 * deep at most; Bun's `JSON.parse` itself happily accepts 100k-deep input, so
 * the cap has to be enforced here for `nesting too deep` to ever fire.
 */
export const MAX_NESTING_DEPTH = 256;

const NESTING_TOO_DEEP = "nesting too deep";

// One open `{` or `[`. `keys` is null for arrays; `expectKey` is true while the
// next string in an object frame is a key (right after `{` or `,`).
type Frame = { keys: Set<string> | null; expectKey: boolean };

/** Index of the closing quote of the string opened at `start`, or -1 if unterminated. */
function findStringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === '"') {
      return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Returns the first key repeated within a single object (raw, as written), or
 * null. Strings are skipped whole so braces/quotes inside them are ignored.
 * Throws `RangeError` when nesting exceeds `MAX_NESTING_DEPTH`.
 */
export function findDuplicateKey(text: string): string | null {
  const stack: Frame[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const top = stack[stack.length - 1];
    if (ch === '"') {
      const end = findStringEnd(text, i);
      if (end < 0) {
        return null;
      }
      if (top?.keys && top.expectKey) {
        const key = text.slice(i + 1, end);
        if (top.keys.has(key)) {
          return key;
        }
        top.keys.add(key);
        top.expectKey = false;
      }
      i = end + 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      if (stack.length >= MAX_NESTING_DEPTH) {
        throw new RangeError(NESTING_TOO_DEEP);
      }
      stack.push({ keys: ch === "{" ? new Set<string>() : null, expectKey: ch === "{" });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === "," && top?.keys) {
      top.expectKey = true;
    }
    i += 1;
  }
  return null;
}

/**
 * `JSON.parse` plus the checks it does not do: duplicate keys within one object
 * and a nesting cap. NaN/Infinity/trailing commas are already syntax errors.
 */
export function parseJsonStrict(text: string): ParseResult {
  try {
    const value: unknown = JSON.parse(text);
    const duplicate = findDuplicateKey(text);
    if (duplicate !== null) {
      return { ok: false, error: `duplicate key ${duplicate}` };
    }
    return { ok: true, value };
  } catch (err) {
    if (err instanceof RangeError) {
      return { ok: false, error: NESTING_TOO_DEEP };
    }
    if (err instanceof SyntaxError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
