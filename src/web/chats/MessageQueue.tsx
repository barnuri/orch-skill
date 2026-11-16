import { useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { describeFailure } from "../api/result";
import type { ApiResult, NonOk } from "../api/result";
import { queueApi } from "./queue-api";
import { attachmentLabel, dropped, moved, pausedNotice, preview, queuedCountLabel, runningItem, waiting } from "./queue-logic";
import type { QueueItem, QueueSnapshot } from "./queue-logic";

const STARTED = "Already started";

function failureText(result: NonOk, fallback: string): string {
  const text = describeFailure(result, fallback);
  return result.kind === "error" && result.status === 409 && text.startsWith(STARTED) ? STARTED : text;
}

function Grip() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="9" cy="6" r="1.6" /><circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" /><circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" /><circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

function Arrow({ down }: { down: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={down ? "m6 9 6 6 6-6" : "m6 15 6-6 6 6"} />
    </svg>
  );
}

/** `2 queued` for the chat header; amber while the queue is paused. Renders nothing for an empty queue. */
export function QueueCounter({ snapshot }: { snapshot: QueueSnapshot }) {
  const count = waiting(snapshot).length;
  if (count === 0) {
    return null;
  }
  return (
    <span className={`chat-queued mono${snapshot.paused ? " is-paused" : ""}`} data-testid="queue-count" title={snapshot.paused ? "The queue is paused" : "Messages waiting for the running reply"}>
      {queuedCountLabel(count)}
      {snapshot.paused ? " · paused" : ""}
    </span>
  );
}

/** Quiet pending bubbles at the end of the thread: queued messages, until they start and become normal messages. */
export function QueueBubbles({ items }: { items: QueueItem[] }) {
  const list = items.filter((i) => i.state === "queued");
  if (list.length === 0) {
    return null;
  }
  return (
    <div className="queue-bubbles" data-testid="queue-bubbles">
      {list.map((item) => (
        <div className="msg msg-user msg-queued" data-role="user" data-queued={item.id} key={item.id}>
          <div className="bubble">
            {item.text.trim() !== "" ? <p className="user-text">{item.text}</p> : null}
            {item.attachment_ids.length > 0 ? <p className="queue-files">{attachmentLabel(item.attachment_ids.length)}</p> : null}
          </div>
          <div className="msg-foot">
            <span className="msg-status is-queued">Queued</span>
            <span className="msg-meta mono">#{item.position}</span>
            {item.edited_at !== null ? <span className="msg-meta">edited</span> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

interface TrayProps {
  chatId: string;
  snapshot: QueueSnapshot;
  running: boolean;
  /** Text of the reply being worked on, when the queue itself has no running item (a message sent directly). */
  runningText?: string | null;
  onStop: () => void;
  /** The server's answer to a change; the live stream sends the same snapshot, so this only makes the screen quicker. */
  onChange: (snapshot: QueueSnapshot) => void;
}

/** The queue above the composer: the running message with Stop, then the waiting ones with reorder, edit, delete and send now. */
export function QueueTray({ chatId, snapshot, running, runningText = null, onStop, onChange }: TrayProps) {
  const list = waiting(snapshot);
  const current = runningItem(snapshot);
  const [open, setOpen] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const ids = list.map((i) => i.id);

  useEffect(() => {
    if (editing !== null) {
      editor.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (confirming !== null) {
      confirmButton.current?.focus();
    }
  }, [confirming]);
  // An item that left the queue (it started, or it was removed elsewhere) ends its edit or confirmation.
  useEffect(() => {
    if (editing !== null && !ids.includes(editing)) {
      setEditing(null);
    }
    if (confirming !== null && !ids.includes(confirming)) {
      setConfirming(null);
    }
  }, [ids.join(","), editing, confirming]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on the id list

  if (list.length === 0) {
    return null;
  }

  const note = (id: string, text: string | null): void => {
    setNotes((n) => {
      const { [id]: _old, ...rest } = n;
      return text === null ? rest : { ...rest, [id]: text };
    });
  };
  const refresh = async (): Promise<void> => {
    const res = await queueApi.read(chatId);
    if (res.kind === "ok") {
      onChange(res.body);
    }
  };
  const run = async <T,>(id: string, work: () => Promise<ApiResult<T>>, fallback: string, done?: (body: T) => void): Promise<boolean> => {
    setBusy(true);
    note(id, null);
    const res = await work();
    setBusy(false);
    if (res.kind === "ok") {
      done?.(res.body);
      return true;
    }
    if (res.kind !== "unchanged") {
      note(id, failureText(res, fallback));
    }
    void refresh();
    return false;
  };

  const move = (id: string, delta: number): void => {
    const next = moved(ids, id, delta);
    if (next.join() !== ids.join()) {
      void run(id, () => queueApi.reorder(chatId, next), "could not reorder", onChange);
    }
  };
  const save = async (id: string): Promise<void> => {
    const text = draft;
    const item = list.find((i) => i.id === id);
    if (item !== undefined && text === item.text) {
      setEditing(null);
      return;
    }
    const ok = await run(id, () => queueApi.edit(chatId, id, { content: text }), "could not save", () => undefined);
    if (ok) {
      setEditing(null);
      void refresh();
    }
  };
  const remove = (id: string): void => {
    void run(id, () => queueApi.cancel(chatId, id), "could not delete", () => void refresh());
  };
  const sendNow = (id: string): void => {
    setConfirming(null);
    void run(id, () => queueApi.sendNow(chatId, id), "could not send now", () => void refresh());
  };
  const onEditKey = (event: KeyboardEvent<HTMLTextAreaElement>, id: string): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      setEditing(null);
      note(id, null);
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void save(id);
    }
  };
  const onDrop = (event: DragEvent, target: string): void => {
    event.preventDefault();
    const id = dragging;
    setDragging(null);
    setOver(null);
    if (id !== null && id !== target) {
      const next = dropped(ids, id, target);
      void run(id, () => queueApi.reorder(chatId, next), "could not reorder", onChange);
    }
  };

  const runningLabel = current?.text ?? runningText ?? "";
  return (
    <section className="queue-tray" aria-label="Message queue" data-testid="queue-tray">
      <header className="queue-head">
        <button type="button" className="queue-toggle" aria-expanded={open} onClick={() => { setOpen(!open); }}>
          <span className={`queue-chev${open ? " is-open" : ""}`} aria-hidden="true"><Arrow down /></span>
          <span className="queue-title">Queue</span>
          <span className="queue-count mono" data-testid="queue-tray-count">{list.length}</span>
        </button>
        {snapshot.paused ? (
          <button type="button" className="btn primary queue-resume" data-testid="queue-resume" disabled={busy} onClick={() => void run("tray", () => queueApi.resume(chatId), "could not resume", onChange)}>
            Resume
          </button>
        ) : null}
      </header>
      {snapshot.paused ? <p className="queue-paused" role="status" data-testid="queue-paused">{pausedNotice(snapshot.reason, list.length)}</p> : null}
      {notes.tray !== undefined ? <p className="queue-note" role="alert">{notes.tray}</p> : null}
      {open ? (
        <>
          {running ? (
            <div className="queue-running" data-testid="queue-running">
              <span className="queue-dot" aria-hidden="true" />
              <span className="queue-label">Running</span>
              <span className="queue-text">{preview(runningLabel)}</span>
              <button type="button" className="btn danger queue-stop" onClick={onStop}>Stop</button>
            </div>
          ) : null}
          <ol className="queue-list">
            {list.map((item, index) => (
              <li
                key={item.id}
                className={`queue-item${dragging === item.id ? " is-dragging" : ""}${over === item.id && dragging !== item.id ? " is-over" : ""}`}
                data-testid="queue-item"
                data-qid={item.id}
                draggable={editing !== item.id}
                onDragStart={(e) => {
                  setDragging(item.id);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", item.id);
                }}
                onDragOver={(e) => {
                  if (dragging !== null) {
                    e.preventDefault();
                    setOver(item.id);
                  }
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                onDrop={(e) => { onDrop(e, item.id); }}
              >
                <span className="queue-grip" aria-hidden="true" title="Drag to reorder"><Grip /></span>
                <span className="queue-pos mono" aria-label={`Position ${index + 1}`}>{index + 1}</span>
                {editing === item.id ? (
                  <div className="queue-edit">
                    <textarea
                      ref={editor}
                      className="queue-editor"
                      aria-label={`Edit queued message ${index + 1}`}
                      value={draft}
                      rows={3}
                      onChange={(e) => { setDraft(e.target.value); }}
                      onKeyDown={(e) => { onEditKey(e, item.id); }}
                    />
                    <div className="queue-edit-actions">
                      <button type="button" className="btn primary" disabled={busy} onClick={() => void save(item.id)}>Save</button>
                      <button type="button" className="btn" onClick={() => { setEditing(null); note(item.id, null); }}>Cancel</button>
                      <span className="queue-hint">Esc cancels · {typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl"}+Enter saves</span>
                    </div>
                  </div>
                ) : (
                  <div className="queue-body">
                    <span className="queue-text" title={item.text}>{preview(item.text) || "(files only)"}</span>
                    <span className="queue-meta">
                      {item.attachment_ids.length > 0 ? <span className="queue-files">{attachmentLabel(item.attachment_ids.length)}</span> : null}
                      {item.edited_at !== null ? <span>edited</span> : null}
                    </span>
                  </div>
                )}
                {editing === item.id ? null : (
                  <div className="queue-actions">
                    <button type="button" className="icon-btn queue-act" aria-label={`Move message ${index + 1} up`} title="Move up" disabled={busy || index === 0} onClick={() => { move(item.id, -1); }}><Arrow down={false} /></button>
                    <button type="button" className="icon-btn queue-act" aria-label={`Move message ${index + 1} down`} title="Move down" disabled={busy || index === list.length - 1} onClick={() => { move(item.id, 1); }}><Arrow down /></button>
                    <button type="button" className="btn queue-act" onClick={() => { setDraft(item.text); setEditing(item.id); note(item.id, null); }}>Edit</button>
                    <button type="button" className="btn queue-act" disabled={busy} onClick={() => { if (running) { setConfirming(item.id); } else { sendNow(item.id); } }}>Send now</button>
                    <button type="button" className="btn danger queue-act" disabled={busy} onClick={() => { remove(item.id); }}>Delete</button>
                  </div>
                )}
                {confirming === item.id ? (
                  <div className="queue-confirm" role="alertdialog" aria-label="Confirm send now" data-testid="queue-confirm">
                    <p>This stops the running reply. What it wrote so far is kept, then this message runs next.</p>
                    <div className="queue-edit-actions">
                      <button type="button" ref={confirmButton} className="btn danger" onClick={() => { sendNow(item.id); }}>Stop reply and send now</button>
                      <button type="button" className="btn" onClick={() => { setConfirming(null); }}>Keep waiting</button>
                    </div>
                  </div>
                ) : null}
                {notes[item.id] !== undefined ? <p className="queue-note" role="alert">{notes[item.id]}</p> : null}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </section>
  );
}
