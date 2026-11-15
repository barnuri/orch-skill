import { describe, expect, test } from "bun:test";
import type { HarnessStatus } from "../../shared/types/harness-status";
import type { ProfilesDocument } from "../../shared/types/profiles-document";
import { withHarnessEnabled, withSavedEnabled } from "./HarnessesPage";

const h = (id: string, wired = true): HarnessStatus => ({ id, wired, enabled: true, available: true, kind: "cli", description: "", binary: id, needs: [], reason: "" }) as HarnessStatus;
const doc = (disabled?: string[]): ProfilesDocument => ({ profiles: {}, settings: { disabled_harnesses: disabled } }) as unknown as ProfilesDocument;

describe("withSavedEnabled", () => {
  test("takes enabled from the saved settings for wired harnesses only", () => {
    const out = withSavedEnabled([h("claude"), h("pi"), h("aider", false)], doc(["claude", "aider"]));
    expect(out.map((x) => x.enabled)).toEqual([false, true, true]);
  });
  test("keeps the probe values until the document loads", () => {
    expect(withSavedEnabled([h("claude")], null)[0]?.enabled).toBe(true);
  });
  test("round-trips with withHarnessEnabled", () => {
    const next = withHarnessEnabled(doc(), "pi", false);
    expect(withSavedEnabled([h("pi")], next)[0]?.enabled).toBe(false);
  });
});
