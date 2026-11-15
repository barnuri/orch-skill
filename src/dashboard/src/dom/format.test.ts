import { describe, expect, test } from "bun:test";

import { ago, fmtDur, fmtTime, nowIso, truncate } from "./format.ts";

const EM_DASH: string = "—";

describe("fmtTime", () => {
  test("null and empty render as an em dash", () => {
    expect(fmtTime(null)).toBe(EM_DASH);
    expect(fmtTime("")).toBe(EM_DASH);
  });

  // An unparseable stored value is shown as-is: better a visible oddity than a silent dash.
  test("an unparseable value is echoed", () => {
    expect(fmtTime("not a date")).toBe("not a date");
  });

  test("a valid ISO stamp becomes a locale string", () => {
    const out = fmtTime("2026-09-03T10:20:30Z");
    expect(out).not.toBe(EM_DASH);
    expect(out).not.toBe("2026-09-03T10:20:30Z");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("fmtDur", () => {
  test("no start is an em dash", () => {
    expect(fmtDur(null)).toBe(EM_DASH);
  });

  test("sub-minute is seconds only", () => {
    expect(fmtDur("2026-09-03T10:00:00Z", "2026-09-03T10:00:45Z")).toBe("45s");
  });

  test("the minute boundary switches format", () => {
    expect(fmtDur("2026-09-03T10:00:00Z", "2026-09-03T10:00:59Z")).toBe("59s");
    expect(fmtDur("2026-09-03T10:00:00Z", "2026-09-03T10:01:00Z")).toBe("1m 0s");
  });

  test("minutes and seconds under an hour", () => {
    expect(fmtDur("2026-09-03T10:00:00Z", "2026-09-03T10:05:07Z")).toBe("5m 7s");
    expect(fmtDur("2026-09-03T10:00:00Z", "2026-09-03T10:59:59Z")).toBe("59m 59s");
  });

  test("an hour or more drops seconds", () => {
    expect(fmtDur("2026-09-03T10:00:00Z", "2026-09-03T11:00:00Z")).toBe("1h 0m");
    expect(fmtDur("2026-09-03T10:00:00Z", "2026-09-03T12:34:00Z")).toBe("2h 34m");
  });

  // A clock skew between the writer and the viewer must not print "-3s".
  test("an end before the start is an em dash", () => {
    expect(fmtDur("2026-09-03T10:00:05Z", "2026-09-03T10:00:00Z")).toBe(EM_DASH);
  });

  test("an unparseable stamp is an em dash", () => {
    expect(fmtDur("nope", "2026-09-03T10:00:00Z")).toBe(EM_DASH);
  });

  test("a missing end measures against now", () => {
    const start = new Date(Date.now() - 3000).toISOString();
    expect(fmtDur(start)).toMatch(/^[234]s$/);
  });
});

describe("ago", () => {
  test("the last two seconds read as just now", () => {
    expect(ago(Date.now())).toBe("just now");
    expect(ago(Date.now() - 1000)).toBe("just now");
  });

  test("older stamps count seconds", () => {
    expect(ago(Date.now() - 30_000)).toBe("30s ago");
  });

  // A future stamp (clock skew) clamps at zero rather than going negative.
  test("a future stamp clamps to just now", () => {
    expect(ago(Date.now() + 60_000)).toBe("just now");
  });
});

describe("truncate", () => {
  test("short text is untouched", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });

  test("text at the limit is untouched", () => {
    expect(truncate("abcde", 5)).toBe("abcde");
  });

  test("longer text is cut to exactly max, ellipsis included", () => {
    expect(truncate("abcdef", 5)).toBe("abcd…");
    expect(truncate("abcdef", 5).length).toBe(5);
  });
});

describe("nowIso", () => {
  // Must match what `memory add` writes, or the server's validator rejects a UI-added entry.
  test("second precision, Z suffix", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
