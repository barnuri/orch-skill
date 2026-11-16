import { describe, expect, test } from "bun:test";
import { chatOnlyUrl } from "../chats/chat-only-link";
import { looksLikeInsecureFeature, needsSecureContext, showSecureHint } from "./secure-hint";

const phone = { protocol: "http:", hostname: "box.local" };
const base = { loc: phone, attempted: true, dismissed: false, hintEnabled: true, httpsUrl: "https://box.local:6725/" };

describe("secure link hint", () => {
  test("shows only on a non-local http page after a feature was attempted", () => {
    expect(showSecureHint(base)).toBe(true);
    expect(showSecureHint({ ...base, attempted: false })).toBe(false);
    expect(showSecureHint({ ...base, loc: { protocol: "http:", hostname: "localhost" } })).toBe(false);
    expect(showSecureHint({ ...base, loc: { protocol: "https:", hostname: "box.local" } })).toBe(false);
    expect(needsSecureContext({ protocol: "http:", hostname: "127.0.0.1" })).toBe(false);
  });
  test("off after dismissal, with the setting off, or without an https url", () => {
    expect(showSecureHint({ ...base, dismissed: true })).toBe(false);
    expect(showSecureHint({ ...base, hintEnabled: false })).toBe(false);
    expect(showSecureHint({ ...base, httpsUrl: null })).toBe(false);
  });
  test("recognises a missing microphone or clipboard API", () => {
    expect(looksLikeInsecureFeature("undefined is not an object (evaluating 'navigator.mediaDevices.getUserMedia')")).toBe(true);
    expect(looksLikeInsecureFeature("something else")).toBe(false);
  });
  test("generated links keep the origin the page is on", () => {
    expect(chatOnlyUrl("http://box.local:6724", "a", null)).toBe("http://box.local:6724/chat/a");
    expect(chatOnlyUrl("https://box.local:6725", null, "t")).toBe("https://box.local:6725/chat?token=t");
  });
});
