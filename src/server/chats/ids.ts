const ALPHABET: string = "0123456789abcdefghjkmnpqrstvwxyz";

let lastMs = 0;
let seq = 0;

function encode(value: number, width: number): string {
  let out = "";
  let rest = value;
  for (let i = 0; i < width; i++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}

/**
 * Time-sortable id: `<prefix>-<10 chars ms><2 chars sequence><4 random chars>`, base32 lowercase.
 * Ids made later sort later as plain strings, also within one millisecond, so keyset paging on id
 * is creation order.
 */
export function newId(prefix: string, now: number = Date.now()): string {
  const ms = Math.max(now, lastMs);
  seq = ms === lastMs ? seq + 1 : 0;
  lastMs = ms;
  const random = crypto.getRandomValues(new Uint8Array(4));
  let tail = "";
  for (const byte of random) {
    tail += ALPHABET[byte % 32];
  }
  return `${prefix}-${encode(ms, 10)}${encode(seq, 2)}${tail}`;
}

export const ID_PATTERN: RegExp = /^(prj|chat|msg|att)-[0-9a-hjkmnp-tv-z]{16}$/;
