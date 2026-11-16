import { useEffect, useRef, useState } from "react";
import { END_SILENCE_MAX_MS, END_SILENCE_MIN_MS } from "../lib/voice-vad";
import type { ConversationMode } from "../lib/voice-machine";
import { installedVoices } from "./voice";
import type { Conversation } from "./use-voice";

const STATE_LABEL: Record<ConversationMode, string> = {
  off: "",
  starting: "Starting…",
  listening: "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  paused: "Paused",
};

const STATE_HINT: Record<ConversationMode, string> = {
  off: "",
  starting: "Allow the microphone if the browser asks.",
  listening: "Talk: it sends when you stop.",
  thinking: "Working on the reply.",
  speaking: "Talk or tap the orb to interrupt.",
  paused: "Nothing is heard or said.",
};

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const ICONS = {
  mic: "M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  micOff: "M3 3l18 18M9 9v3a3 3 0 0 0 5 2M15 10V6a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11 5.7M12 18v3",
  pause: "M8 5v14M16 5v14",
  play: "M7 4l13 8-13 8z",
  stopSpeech: "M5 9v6h4l5 4V5L9 9zM19 9l-4 6M15 9l4 6",
  gear: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  close: "M6 6l12 12M18 6L6 18",
};

function useVoices(): SpeechSynthesisVoice[] {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => installedVoices());
  useEffect(() => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
    const s = window.speechSynthesis;
    const update = (): void => setVoices(s.getVoices());
    update();
    s.addEventListener?.("voiceschanged", update);
    return () => s.removeEventListener?.("voiceschanged", update);
  }, []);
  return voices;
}

function SettingsSheet({ voice, onClose }: { voice: Conversation; onClose: () => void }) {
  const voices = useVoices();
  const s = voice.settings;
  const byBase = (base: string) => voices.filter((v) => v.lang.toLowerCase().replace("_", "-").replace(/^iw/, "he").startsWith(base));
  const select = (base: string, label: string) => {
    const list = byBase(base);
    return (
      <label className="cv-field">
        <span>{label}</span>
        <select value={s.voices[base] ?? ""} onChange={(e) => voice.updateSettings({ voices: { ...s.voices, [base]: e.target.value } })}>
          <option value="">{list.length === 0 ? "No voice installed" : "Best available"}</option>
          {list.map((v) => (
            <option key={v.voiceURI} value={v.voiceURI}>{v.name} ({v.lang})</option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <div className="cv-sheet" role="dialog" aria-label="Voice settings" data-testid="voice-settings">
      <div className="cv-sheet-head">
        <strong>Voice settings</strong>
        <button type="button" className="icon-btn cv-btn" aria-label="Close settings" onClick={onClose}>{icon(ICONS.close)}</button>
      </div>
      <label className="cv-field">
        <span>Pause before it sends: {(s.silenceMs / 1000).toFixed(1)} s</span>
        <input type="range" min={END_SILENCE_MIN_MS} max={END_SILENCE_MAX_MS} step={100} value={s.silenceMs} onChange={(e) => voice.updateSettings({ silenceMs: Number(e.target.value) })} />
      </label>
      <label className="cv-field">
        <span>Speech speed: {s.rate.toFixed(2)}×</span>
        <input type="range" min={0.5} max={2} step={0.05} value={s.rate} onChange={(e) => voice.updateSettings({ rate: Number(e.target.value) })} />
      </label>
      {select("he", "Hebrew voice")}
      {select("en", "English voice")}
      <label className="cv-check">
        <input type="checkbox" checked={s.speak} onChange={(e) => voice.updateSettings({ speak: e.target.checked })} />
        <span>Read replies aloud</span>
      </label>
      <label className="cv-check">
        <input type="checkbox" checked={s.pushToTalk} onChange={(e) => voice.updateSettings({ pushToTalk: e.target.checked })} />
        <span>Push to talk (hold Space or the button)</span>
      </label>
      <p className="cv-note">Voice engine: your browser. The LLM hub has no speech model.</p>
    </div>
  );
}

/** Full-screen conversation mode: one page mode shared by both shells (it is mounted by ChatView). */
export function ConversationView({ voice }: { voice: Conversation }) {
  const [sheet, setSheet] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const phase = voice.phase;
  const live = phase === "listening" && !voice.muted;
  const insecure = voice.error !== null && /https or localhost/.test(voice.error);

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => before?.focus?.();
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (sheet) setSheet(false);
        else voice.stop();
      } else if (e.key === " " && voice.pushToTalk && !e.repeat && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        voice.pttDown();
      }
    };
    const up = (e: KeyboardEvent): void => {
      if (e.key === " " && voice.pushToTalk) voice.pttUp();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [sheet, voice]);

  const orbLabel = phase === "speaking" ? "Interrupt and talk" : phase === "paused" ? "Resume" : STATE_LABEL[phase];
  return (
    <div className="cv" ref={root} role="dialog" aria-modal="true" aria-label="Voice conversation" data-testid="conversation-view" data-phase={phase} data-muted={voice.muted ? "1" : "0"}>
      <header className="cv-head">
        <span className="cv-title">Voice conversation</span>
        <span className="cv-spacer" />
        <button type="button" className="icon-btn cv-btn" aria-label="Voice settings" aria-expanded={sheet} onClick={() => setSheet((v) => !v)}>{icon(ICONS.gear)}</button>
        <button type="button" className="icon-btn cv-btn" aria-label="End conversation (Esc)" title="End conversation (Esc)" onClick={voice.stop} data-autofocus>{icon(ICONS.close)}</button>
      </header>

      <main className="cv-main">
        <button
          type="button"
          className="cv-orb"
          data-state={voice.muted && phase === "listening" ? "muted" : phase}
          style={{ ["--lvl" as string]: live ? Math.min(1, voice.level).toFixed(2) : "0" }}
          aria-label={orbLabel}
          onClick={() => (phase === "paused" ? voice.resume() : voice.tap())}
          onPointerDown={() => { if (voice.pushToTalk) voice.pttDown(); }}
          onPointerUp={() => { if (voice.pushToTalk) voice.pttUp(); }}
        >
          <span className="cv-orb-core" />
          <span className="cv-orb-ring" />
        </button>
        <p className="cv-state" data-testid="conversation-phase" aria-live="polite">
          {voice.muted && phase === "listening" ? "Mic muted" : STATE_LABEL[phase]}
        </p>
        <p className="cv-hint">{voice.pushToTalk && phase === "listening" ? "Hold Space or the orb to talk." : STATE_HINT[phase]}</p>

        <section className="cv-transcript" aria-label="Transcript">
          <p className="cv-who">You</p>
          <p className="cv-you" dir="auto" data-testid="conversation-heard">{voice.heard !== "" ? voice.heard : "…"}</p>
          <p className="cv-who">Assistant</p>
          <p className="cv-reply" dir="auto" aria-live="polite" data-testid="conversation-reply">
            {voice.reply.length === 0 ? "…" : voice.reply.map((r) => (
              <span key={r.index} dir="auto" className={voice.activeSentence === r.index ? "cv-sentence is-active" : "cv-sentence"} data-active={voice.activeSentence === r.index ? "1" : undefined}>{r.text} </span>
            ))}
          </p>
        </section>

        {voice.notice !== null ? <p className="cv-notice" role="status">{voice.notice}</p> : null}
        {voice.error !== null ? (
          <p className="cv-error" role="alert">
            {voice.error}
            {insecure ? <> <a href="/trust">Open the /trust page</a></> : null}
          </p>
        ) : null}
      </main>

      <footer className="cv-controls">
        <button type="button" className={`btn cv-ctl${voice.muted ? " is-on" : ""}`} aria-pressed={voice.muted} onClick={voice.toggleMute}>
          {icon(voice.muted ? ICONS.micOff : ICONS.mic)}<span>{voice.muted ? "Unmute" : "Mute mic"}</span>
        </button>
        <button type="button" className="btn cv-ctl" onClick={phase === "paused" ? voice.resume : voice.pause}>
          {icon(phase === "paused" ? ICONS.play : ICONS.pause)}<span>{phase === "paused" ? "Resume" : "Pause"}</span>
        </button>
        <button type="button" className="btn cv-ctl" disabled={phase !== "speaking"} onClick={voice.stopSpeakingNow}>
          {icon(ICONS.stopSpeech)}<span>Stop speaking</span>
        </button>
        {voice.pushToTalk ? (
          <button type="button" className="btn primary cv-ctl cv-ptt" onPointerDown={voice.pttDown} onPointerUp={voice.pttUp} onPointerLeave={voice.pttUp}>
            {icon(ICONS.mic)}<span>Hold to talk</span>
          </button>
        ) : null}
        <button type="button" className="btn cv-ctl cv-end" onClick={voice.stop}>End</button>
      </footer>
      {sheet ? <SettingsSheet voice={voice} onClose={() => setSheet(false)} /> : null}
    </div>
  );
}
