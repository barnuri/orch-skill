import { describe, expect, test } from "bun:test";
import { deployText } from "./DeployBadge";

const base = { sha: "a".repeat(40), short: "aaaaaaa", ref: "master", deployed_at: "2026-11-24T10:00:00Z", behind: 0, failed: null };

describe("deployText", () => {
  test("clean", () => expect(deployText(base)).toBe("deployed aaaaaaa"));
  test("behind", () => expect(deployText({ ...base, behind: 2 })).toBe("deployed aaaaaaa · 2 commits behind master"));
  test("behind 1", () => expect(deployText({ ...base, behind: 1 })).toContain("1 commit behind"));
  test("failed", () => expect(deployText({ ...base, failed: "tests failed" })).toBe("deployed aaaaaaa · deploy failed: tests failed"));
  test("none", () => expect(deployText(null)).toBe(""));
});
