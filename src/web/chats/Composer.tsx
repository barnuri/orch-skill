import { useCallback, useEffect, useRef, useState } from "react";
import { takeComposerFocus } from "./composer-focus";
import type { ClipboardEvent, DragEvent, KeyboardEvent, ReactNode } from "react";
import { chatsApi, uploadAttachment } from "../api/chats";
import { filesFromClipboard, formatBytes, isImageMime, loadDraft, saveDraft, validateFile } from "../lib/chat-logic";
import type { Attachment } from "../lib/chat-types";
import { AttachmentTile } from "./Attachments";
import { useNow } from "./use-chat-thread";
import { browserVoice, useDictation } from "./use-voice";
import type { Conversation, VoiceDeps } from "./use-voice";
import { appendTranscript, formatElapsed } from "../lib/voice-logic";

interface Pending {
  key: number;
  name: string;
  size: number;
  progress: number;
  error: string | null;
  preview: string | null;
}

export type Uploader = (chatId: string, file: File, onProgress: (f: number) => void) => { promise: Promise<{ ok: true; attachment: Attachment } | { ok: false; error: string }>; abort: () => void };

interface ComposerProps {
  chatId: string;
  /** Why sending is impossible (no usable harness, archived chat), or null. */
  blocked: string | null;
  running: boolean;
  /** Harness, profile and model pickers, shown above the input. */
  toolbar?: ReactNode;
  onSend: (text: string, attachmentIds: string[]) => Promise<string | null>;
  onStop: () => void;
  onOpenImage: (a: Attachment) => void;
  storage?: Storage;
  upload?: Uploader;
  /** Deletes an upload that was never sent. Failures are ignored: the 24-hour sweep removes leftovers. */
  removeUpload?: (id: string) => Promise<unknown>;
  /** The hands-free voice conversation of this chat (ChatView owns it: it needs the thread). */
  voice?: Conversation;
  /** Microphone, recorder and transcriber; tests pass fakes. */
  voiceDeps?: VoiceDeps;
  /** Opens the schedule sheet with the typed text. Without it the clock button is not shown. */
  onSchedule?: ((text: string) => void) | undefined;
}

const COARSE = "(pointer: coarse)";

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function WaveIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />
    </svg>
  );
}

function LevelMeter({ level }: { level: number }) {
  return (
    <span className="voice-level" aria-hidden="true">
      {[0.15, 0.35, 0.6, 0.35, 0.15].map((w, i) => (
        // eslint-disable-next-line react/no-array-index-key -- fixed five bars
        <span key={i} style={{ transform: `scaleY(${Math.max(0.15, Math.min(1, level * (1.6 - Math.abs(2 - i) * 0.35) + w * 0.2))})` }} />
      ))}
    </span>
  );
}

export function Composer({ chatId, blocked, running, toolbar, onSend, onStop, onOpenImage, storage, upload = uploadAttachment, removeUpload = chatsApi.removeAttachment, voice, voiceDeps = browserVoice, onSchedule }: ComposerProps) {
  const store = storage ?? sessionStorage;
  const [text, setText] = useState(() => loadDraft(store, chatId).text);
  const [attachments, setAttachments] = useState<Attachment[]>(() => loadDraft(store, chatId).attachments);
  const [pending, setPending] = useState<Pending[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const counter = useRef(0);
  const aborts = useRef(new Map<number, () => void>());
  const pendingRef = useRef<Pending[]>([]);
  const sendingRef = useRef(false);
  const dictation = useDictation((heard) => {
    setText((current) => appendTranscript(current, heard));
    area.current?.focus();
  }, voiceDeps);
  const recording = dictation.state !== "idle";
  const talking = voice !== undefined && voice.phase !== "off";
  const now = useNow(dictation.state === "recording");
  const voiceErrors = [dictation.error, voice?.error ?? null].filter((e): e is string => e !== null);
  useEffect(() => {
    if (takeComposerFocus()) {
      area.current?.focus();
    }
  }, []);
  useEffect(
    () => () => {
      for (const p of pendingRef.current) {
        if (p.preview !== null) {
          URL.revokeObjectURL(p.preview);
        }
      }
    },
    [],
  );
  pendingRef.current = pending;
  const attRef = useRef<Attachment[]>(attachments);
  attRef.current = attachments;

  useEffect(() => {
    saveDraft(store, chatId, { text, attachments });
  }, [store, chatId, text, attachments]);

  useEffect(() => {
    const el = area.current;
    if (el !== null) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  }, [text]);

  const addFiles = useCallback(
    (files: File[]) => {
      const errors: string[] = [];
      for (const file of files) {
        const taken = attRef.current.reduce((n, a) => n + a.size, 0) + pendingRef.current.filter((p) => p.error === null).reduce((n, p) => n + p.size, 0);
        const count = attRef.current.length + pendingRef.current.filter((p) => p.error === null).length;
        const problem = validateFile(file, taken, count);
        if (problem !== null) {
          errors.push(problem);
          continue;
        }
        const key = (counter.current += 1);
        const entry: Pending = { key, name: file.name, size: file.size, progress: 0, error: null, preview: isImageMime(file.type) ? URL.createObjectURL(file) : null };
        pendingRef.current = [...pendingRef.current, entry];
        setPending(pendingRef.current);
        const handle = upload(chatId, file, (progress) => {
          setPending((list) => list.map((p) => (p.key === key ? { ...p, progress } : p)));
        });
        aborts.current.set(key, handle.abort);
        void handle.promise.then((res) => {
          aborts.current.delete(key);
          if (res.ok) {
            setAttachments((list) => [...list, res.attachment]);
            setPending((list) => list.filter((p) => p.key !== key));
            if (entry.preview !== null) {
              URL.revokeObjectURL(entry.preview);
            }
          } else {
            setPending((list) => list.map((p) => (p.key === key ? { ...p, error: res.error } : p)));
          }
        });
      }
      setProblems(errors);
    },
    [chatId, upload],
  );

  const uploading = pending.some((p) => p.error === null);
  const canSend = blocked === null && !sending && !uploading && (text.trim() !== "" || attachments.length > 0);

  const submit = async (): Promise<void> => {
    if (!canSend || sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    const sent = new Set(attachments.map((a) => a.id));
    const failure = await onSend(text.trim(), [...sent]).finally(() => {
      sendingRef.current = false;
    });
    setSending(false);
    if (failure === null) {
      setText("");
      setAttachments((list) => list.filter((a) => !sent.has(a.id)));
      setProblems([]);
    } else {
      setProblems([failure]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !window.matchMedia(COARSE).matches) {
      event.preventDefault();
      void submit();
    }
  };
  const onPaste = (event: ClipboardEvent): void => {
    const files = filesFromClipboard(event.clipboardData, Date.now());
    if (files.length > 0) {
      event.preventDefault();
      addFiles(files);
    }
  };
  const onDrop = (event: DragEvent): void => {
    event.preventDefault();
    setDragging(false);
    addFiles(Array.from(event.dataTransfer.files));
  };

  return (
    <div
      className="composer"
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        // dragleave also fires when the pointer moves onto a child (the textarea, a chip): keep the highlight then.
        const to = e.relatedTarget as Node | null;
        if (to === null || !e.currentTarget.contains(to)) {
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      {problems.length > 0 || voiceErrors.length > 0 ? (
        <ul className="composer-problems" role="alert">
          {[...problems, ...voiceErrors].map((p) => (
            <li key={p}>{p}{p.includes("/trust page") ? <> <a href="/trust">Open /trust</a></> : null}</li>
          ))}
        </ul>
      ) : null}
      {recording ? (
        <div className="voice-bar" data-testid="dictation-bar" role="status">
          <span className={`voice-dot${dictation.state === "recording" ? " is-live" : ""}`} aria-hidden="true" />
          <span className="voice-label">
            {dictation.state === "starting" ? "Starting microphone…" : dictation.state === "transcribing" ? "Transcribing…" : "Recording"}
          </span>
          {dictation.state === "recording" ? (
            <>
              <span className="voice-time mono" data-testid="dictation-time">{formatElapsed(dictation.startedAt === null ? 0 : now - dictation.startedAt)}</span>
              <LevelMeter level={dictation.level} />
            </>
          ) : null}
          {dictation.partial !== "" ? <span className="voice-partial" data-testid="dictation-partial" dir="auto">{dictation.partial}</span> : null}
          <span className="voice-spacer" />
          <button type="button" className="btn" onClick={dictation.cancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" disabled={dictation.state !== "recording"} onClick={dictation.finish}>
            Done
          </button>
        </div>
      ) : null}
      {attachments.length > 0 || pending.length > 0 ? (
        <div className="att-row composer-atts" data-testid="composer-atts">
          {attachments.map((a) => (
            <div className="att-wrap" key={a.id}>
              <AttachmentTile attachment={a} onOpen={onOpenImage} />
              <button
                type="button"
                className="att-remove"
                aria-label={`Remove ${a.filename}`}
                onClick={() => {
                  setAttachments((list) => list.filter((x) => x.id !== a.id));
                  void removeUpload(a.id).catch(() => undefined);
                }}
              >
                ×
              </button>
            </div>
          ))}
          {pending.map((p) => (
            <div className={`att-wrap att-pending${p.error !== null ? " is-error" : ""}`} key={p.key}>
              <div className="att-chip">
                {p.preview !== null ? <img className="att-mini" src={p.preview} alt="" /> : null}
                <span className="att-name">{p.name}</span>
                <span className="att-size">{p.error ?? `${formatBytes(p.size)} · ${Math.round(p.progress * 100)}%`}</span>
                {p.error === null ? <span className="att-bar" style={{ width: `${Math.round(p.progress * 100)}%` }} /> : null}
              </div>
              <button
                type="button"
                className="att-remove"
                aria-label={`Remove ${p.name}`}
                onClick={() => {
                  aborts.current.get(p.key)?.();
                  if (p.preview !== null) {
                    URL.revokeObjectURL(p.preview);
                  }
                  pendingRef.current = pendingRef.current.filter((x) => x.key !== p.key);
                  setPending((list) => list.filter((x) => x.key !== p.key));
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {toolbar !== undefined ? <div className="composer-toolbar" data-testid="composer-toolbar">{toolbar}</div> : null}
      <div className="composer-row">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          data-testid="file-input"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        {onSchedule === undefined ? null : (
          <button type="button" className="icon-btn composer-clock" aria-label="Schedule, loop or monitor" title="Schedule this prompt, repeat it, or watch something" disabled={blocked !== null} data-testid="composer-clock" onClick={() => { onSchedule(text.trim()); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          </button>
        )}
        <button type="button" className="icon-btn composer-attach" aria-label="Attach files" title="Attach files" onClick={() => { fileInput.current?.click(); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m21 11-9 9a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" />
          </svg>
        </button>
        <textarea
          ref={area}
          className="composer-text"
          rows={1}
          value={text}
          placeholder={blocked ?? "Message, or paste a file"}
          aria-label="Message"
          disabled={blocked !== null}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
        />
        <button
          type="button"
          className={`icon-btn composer-mic${recording ? " is-on" : ""}`}
          aria-label={recording ? "Stop dictation" : "Dictate"}
          title={recording ? "Stop and transcribe" : "Dictate: speak, then edit and send"}
          aria-pressed={recording}
          disabled={blocked !== null || talking || dictation.state === "transcribing" || dictation.state === "starting"}
          onClick={() => {
            if (dictation.state === "recording") {
              dictation.finish();
            } else {
              dictation.start();
            }
          }}
        >
          <MicIcon />
        </button>
        {voice !== undefined ? (
          <button
            type="button"
            className={`icon-btn composer-voice${talking ? " is-on" : ""}`}
            aria-label={talking ? "Open voice conversation" : "Start voice conversation"}
            title={talking ? "Voice conversation is open" : "Voice conversation: talk hands-free, replies are read aloud"}
            aria-pressed={talking}
            disabled={blocked !== null || recording}
            onClick={() => {
              if (!talking) {
                dictation.clearError();
                voice.start();
              }
            }}
          >
            <WaveIcon />
          </button>
        ) : null}
        {running ? (
          <button type="button" className="btn danger composer-stop" onClick={onStop}>
            Stop
          </button>
        ) : null}
        <button type="button" className="btn primary composer-send" disabled={!canSend} onClick={() => void submit()} title={uploading ? "Wait for uploads" : running ? "Add to the queue: it runs when the reply ends" : undefined}>
          {uploading ? "Uploading…" : running ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
