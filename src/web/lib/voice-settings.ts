import { clampEndSilence, END_SILENCE_DEFAULT_MS } from "./voice-vad";

export const VOICE_SETTINGS_KEY = "orch.voice.settings.v1";

export interface VoiceSettings {
  /** End-of-speech silence in hands-free mode, 800..4000 ms. */
  silenceMs: number;
  /** Text to speech engine. The hub has no speech model (checked: /v1/models lists only whisper, ivrit and parakeet for audio), so only the browser engine exists. */
  engine: "browser";
  /** voiceURI per language base (`he`, `en`); empty means the best installed voice. */
  voices: Record<string, string>;
  rate: number;
  pushToTalk: boolean;
  /** Read the reply aloud. Off: the mode only listens and shows text. */
  speak: boolean;
}

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = { silenceMs: END_SILENCE_DEFAULT_MS, engine: "browser", voices: {}, rate: 1, pushToTalk: false, speak: true };

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function normalizeVoiceSettings(raw: unknown): VoiceSettings {
  const r = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const voices: Record<string, string> = {};
  if (typeof r.voices === "object" && r.voices !== null) {
    for (const [k, v] of Object.entries(r.voices as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") voices[k] = v;
    }
  }
  const rate = typeof r.rate === "number" && Number.isFinite(r.rate) ? Math.min(2, Math.max(0.5, r.rate)) : 1;
  return {
    silenceMs: clampEndSilence(typeof r.silenceMs === "number" ? r.silenceMs : END_SILENCE_DEFAULT_MS),
    engine: "browser",
    voices,
    rate,
    pushToTalk: r.pushToTalk === true,
    speak: r.speak !== false,
  };
}

export function loadVoiceSettings(storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage): VoiceSettings {
  try {
    const text = storage?.getItem(VOICE_SETTINGS_KEY);
    return normalizeVoiceSettings(text === null || text === undefined ? null : JSON.parse(text));
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

export function saveVoiceSettings(settings: VoiceSettings, storage: StorageLike | null = typeof localStorage === "undefined" ? null : localStorage): void {
  try {
    storage?.setItem(VOICE_SETTINGS_KEY, JSON.stringify(normalizeVoiceSettings(settings)));
  } catch {
    // storage full or blocked: the settings still apply for this session
  }
}
