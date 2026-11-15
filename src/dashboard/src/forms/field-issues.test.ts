import { describe, expect, test } from "bun:test";

import { deepCopy, envLinesToObject, linesOf, longestPathMatch, objectToEnvLines } from "./field-issues.ts";

describe("linesOf", () => {
  test("empty text has no lines", () => {
    expect(linesOf("")).toEqual([]);
    expect(linesOf("   \n\n  ")).toEqual([]);
  });

  test("lines are trimmed and blanks dropped", () => {
    expect(linesOf("  a  \n\n b \n")).toEqual(["a", "b"]);
  });

  // A textarea saved on Windows, or pasted from one, must not leave \r on every value.
  test("CRLF splits the same as LF", () => {
    expect(linesOf("a\r\nb")).toEqual(["a", "b"]);
  });
});

describe("envLinesToObject", () => {
  test("KEY=VALUE lines become an object", () => {
    const parsed = envLinesToObject("A=1\nB=2");
    expect(parsed.env).toEqual({ A: "1", B: "2" });
    expect(parsed.issues).toEqual([]);
  });

  // Only the first `=` splits, so a value may itself contain `=` (base64, query strings).
  test("only the first separator splits", () => {
    expect(envLinesToObject("TOKEN=a=b=c").env).toEqual({ TOKEN: "a=b=c" });
  });

  test("an empty value is kept", () => {
    expect(envLinesToObject("EMPTY=").env).toEqual({ EMPTY: "" });
  });

  // The whole line is trimmed first, then the key again — so inner spacing around the
  // separator survives on the value side but a trailing space does not.
  test("the key is trimmed and inner spacing survives on the value", () => {
    expect(envLinesToObject("  K  = v ").env).toEqual({ K: " v" });
  });

  test("a line without a separator is reported at the given path", () => {
    const parsed = envLinesToObject("A=1\noops", "profiles.x.env");
    expect(parsed.env).toEqual({ A: "1" });
    expect(parsed.issues).toEqual([{ path: "profiles.x.env", reason: "each line must be KEY=VALUE" }]);
  });

  test("the path defaults to env", () => {
    expect(envLinesToObject("oops").issues[0]?.path).toBe("env");
  });

  // Matches what JSON.parse does with a duplicate key on disk, so a round-trip is lossless.
  test("a later duplicate wins", () => {
    expect(envLinesToObject("A=1\nA=2").env).toEqual({ A: "2" });
  });
});

describe("objectToEnvLines", () => {
  test("an empty object is an empty string", () => {
    expect(objectToEnvLines({})).toBe("");
  });

  test("key order on disk is preserved", () => {
    expect(objectToEnvLines({ B: "2", A: "1" })).toBe("B=2\nA=1");
  });

  test("a round-trip through the textarea keeps the values", () => {
    const env = { TOKEN: "a=b", EMPTY: "" };
    expect(envLinesToObject(objectToEnvLines(env)).env).toEqual(env);
  });
});

describe("longestPathMatch", () => {
  test("an exact path matches itself", () => {
    expect(longestPathMatch(["profiles.a"], "profiles.a")).toBe("profiles.a");
  });

  test("the longest covering path wins", () => {
    expect(longestPathMatch(["profiles.a", "profiles.a.env"], "profiles.a.env.FOO")).toBe(
      "profiles.a.env",
    );
  });

  // A prefix is not enough — the next character has to end the segment.
  test("a sibling with a shared prefix does not match", () => {
    expect(longestPathMatch(["profiles.a"], "profiles.ab")).toBeNull();
  });

  test("an array index is covered by its container", () => {
    expect(longestPathMatch(["profiles.a.flags"], "profiles.a.flags[2]")).toBe("profiles.a.flags");
  });

  // The form may label a control without the index; the issue path always carries one.
  test("an indexed issue path matches an unindexed field", () => {
    expect(longestPathMatch(["memory.outcome"], "memory[3].outcome")).toBe("memory.outcome");
  });

  test("an unmatched issue belongs in the top list", () => {
    expect(longestPathMatch(["profiles.a"], "profiles.b")).toBeNull();
    expect(longestPathMatch([], "anything")).toBeNull();
  });
});

describe("deepCopy", () => {
  test("nested structure is not shared with the source", () => {
    const source = { a: { list: [1, 2] } };
    const copy = deepCopy(source);
    expect(copy).toEqual(source);
    copy.a.list.push(3);
    expect(source.a.list).toEqual([1, 2]);
  });
});
