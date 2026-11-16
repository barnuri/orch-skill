import { describe, expect, test } from "bun:test";
import { matchSpokenOption, ScreenAwake, voiceOriginProblem } from "./voice-env";
import { DEFAULT_VOICE_SETTINGS, loadVoiceSettings, normalizeVoiceSettings, saveVoiceSettings, VOICE_SETTINGS_KEY } from "./voice-settings";

const mem = () => {
  const d = new Map<string, string>();
  return { getItem: (k: string) => d.get(k) ?? null, setItem: (k: string, v: string) => void d.set(k, v), d };
};

describe("secure context message", () => {
  test("plain http points to https and the /trust page; a secure page with a mic is fine", () => {
    const msg = voiceOriginProblem({ isSecureContext: false, protocol: "http:", hostname: "192.168.1.5", hasMediaDevices: false });
    expect(msg).toContain("https or localhost");
    expect(msg).toContain("/trust");
    expect(msg?.split(". ").length).toBeLessThanOrEqual(2);
    expect(voiceOriginProblem({ isSecureContext: true, protocol: "https:", hostname: "x", hasMediaDevices: true })).toBeNull();
    expect(voiceOriginProblem({ isSecureContext: true, protocol: "https:", hostname: "x", hasMediaDevices: false })).toContain("no microphone access");
  });
});

describe("wake lock", () => {
  test("requests a screen lock, releases it, and takes it again when the tab returns", async () => {
    const calls: string[] = [];
    const host = { wakeLock: { request: async (t: "screen") => { calls.push(`request ${t}`); return { release: async () => { calls.push("release"); } }; } } };
    const w = new ScreenAwake(host);
    expect(await w.acquire()).toBe(true);
    expect(w.held).toBe(true);
    await w.release();
    expect(w.held).toBe(false);
    expect(calls).toEqual(["request screen", "release"]);
    await w.acquire();
    (w as unknown as { sentinel: null }).sentinel = null;
    await w.reacquire();
    expect(calls.filter((c) => c === "request screen").length).toBe(3);
  });

  test("no API or a denied request is not an error", async () => {
    expect(await new ScreenAwake({}).acquire()).toBe(false);
    expect(await new ScreenAwake({ wakeLock: { request: async () => { throw new Error("denied"); } } }).acquire()).toBe(false);
  });
});

describe("voice settings", () => {
  test("defaults: 1.8 s silence; saved and loaded from localStorage; values are clamped", () => {
    const s = mem();
    expect(loadVoiceSettings(s).silenceMs).toBe(1800);
    saveVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, silenceMs: 2600, rate: 1.25, pushToTalk: true, voices: { he: "Carmit" } }, s);
    expect(s.d.has(VOICE_SETTINGS_KEY)).toBe(true);
    expect(loadVoiceSettings(s)).toEqual({ silenceMs: 2600, engine: "browser", voices: { he: "Carmit" }, rate: 1.25, pushToTalk: true, speak: true });
    expect(normalizeVoiceSettings({ silenceMs: 10, rate: 9 })).toMatchObject({ silenceMs: 800, rate: 2 });
    expect(normalizeVoiceSettings({ silenceMs: 99999 }).silenceMs).toBe(4000);
    s.d.set(VOICE_SETTINGS_KEY, "{broken");
    expect(loadVoiceSettings(s)).toEqual(DEFAULT_VOICE_SETTINGS);
  });
});

describe("spoken answers to a question card", () => {
  const options = [{ label: "Ship it" }, { label: "Wait a day" }, { label: "Cancel everything" }];
  test("by number, ordinal (English and Hebrew), label, or a word of the label", () => {
    expect(matchSpokenOption("two", options)).toBe("Wait a day");
    expect(matchSpokenOption("option 3", options)).toBe("Cancel everything");
    expect(matchSpokenOption("השלישי", options)).toBe("Cancel everything");
    expect(matchSpokenOption("please ship it now", options)).toBe("Ship it");
    expect(matchSpokenOption("cancel", options)).toBe("Cancel everything");
    expect(matchSpokenOption("banana", options)).toBeNull();
    expect(matchSpokenOption("", options)).toBeNull();
  });
});
