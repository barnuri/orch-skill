import { useState } from "react";
import type { ActiveItem } from "../../shared/types/active-item";
import { api } from "../api/client";
import { dropEtag, keys, queryClient } from "../api/queries";
import { describeFailure } from "../api/result";
import { useConfirm } from "../components/ConfirmDialog";
import { Countdown } from "../components/Countdown";
import { PanelBox } from "../components/Panel";
import { useToast } from "../components/Toast";
import { ChatLink } from "../chats/ChatLink";
import { everyLabel, rel, until } from "../lib/format";

function Cell({ label, children, danger = false }: { label: string; children: React.ReactNode; danger?: boolean }) {
  return (
    <div className="active-cell">
      <span className="active-cell-label">{label}</span>
      <span className={`active-cell-value${danger ? " is-er" : ""}`}>{children}</span>
    </div>
  );
}

function RuntimeMeter({ item }: { item: ActiveItem }) {
  const started = Date.parse(item.started) / 1000;
  const span = item.deadline - started;
  const done = Math.min(1, Math.max(0, (Date.now() / 1000 - started) / span));
  return (
    <div className="meter" role="presentation" title="Time used of the maximum runtime">
      <span style={{ width: `${(done * 100).toFixed(1)}%` }} />
    </div>
  );
}

function loopNote(item: ActiveItem): string {
  const session = item.session === "resume" ? "one resumed session" : item.session === "id" ? "a chosen session" : "fresh session each tick";
  return `every ${everyLabel(item.interval)} · ${session}${item.when_idle ? ` · waits for idle (${item.skipped ?? 0} skipped)` : ""}`;
}

function Metrics({ item }: { item: ActiveItem }) {
  if (item.kind === "loop") {
    const max = item.max ?? 0;
    const iteration = item.iteration ?? 0;
    const failed = item.last_exit !== null && item.last_exit !== undefined && item.last_exit !== 0;
    const exit = item.last_exit === null || item.last_exit === undefined ? "no exit yet" : `last exit ${item.last_exit}`;
    const next = item.next ?? 0;
    return (
      <>
        <div className="active-cell">
          <span className="active-cell-label">iteration</span>
          <span className="active-cell-value">{max > 0 ? `${iteration}/${max}` : String(iteration)}</span>
          <RuntimeMeter item={item} />
          <span className={`active-cell-sub${failed ? " is-er" : ""}`}>{exit}</span>
        </div>
        <Cell label="next tick in">{item.status === "running" ? next > 0 ? <Countdown at={next} /> : until(0) : "—"}</Cell>
      </>
    );
  }
  return (
    <>
      <div className="active-cell">
        <span className="active-cell-label">events</span>
        <span className="active-cell-value">{String(item.events ?? 0)}</span>
        <RuntimeMeter item={item} />
        <span className="active-cell-sub">{item.last_event ? `last ${rel(item.last_event)}` : "none yet"}</span>
      </div>
      <Cell label="runs">{everyLabel(item.interval)}</Cell>
    </>
  );
}

function ActiveRow({ item }: { item: ActiveItem }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const needs = item.status !== "running";
  const tone = item.status === "failed" ? " is-failed" : item.status === "lost" ? " is-lost" : "";
  const noun = item.kind === "loop" ? "loop" : "monitor";
  const stop = async (): Promise<void> => {
    const confirmed = await confirm({
      title: `Stop ${noun} ${item.name}?`,
      body:
        item.kind === "loop"
          ? "The loop ends after the current call is cut off. Its run is marked cancelled. You can start a new loop with the same prompt."
          : "The monitor and its command stop. Events already captured stay readable.",
      confirmLabel: `Stop ${noun}`,
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    setBusy(true);
    const result = await api.stopActive(item.id);
    setBusy(false);
    if (result.kind === "ok") {
      toast("ok", `${item.kind === "loop" ? "Loop" : "Monitor"} stopped`);
      dropEtag(keys.active);
      void queryClient.invalidateQueries({ queryKey: [keys.active] });
    } else {
      toast("error", describeFailure(result, "Stop failed"));
    }
  };
  return (
    <div className={`active-row is-${item.kind}${tone}`} role="listitem">
      <div className="active-title">
        <div className="active-head">
          <span className={`tag ${item.kind}`}>{item.kind === "loop" ? "Loop" : "Watch"}</span>
          <span className="active-name" title={item.name}>
            {item.name}
          </span>
          <span className={`chip ${needs ? item.status : "running"}`}>{needs ? item.status : "live"}</span>
        </div>
        <div className="active-id">{item.id}</div>
        {item.chat_id === undefined ? null : <div className="active-chat"><span className="active-cell-label">chat</span> <ChatLink id={item.chat_id} /></div>}
        <div className={item.kind === "loop" ? "active-note" : "active-note mono"} title={item.cmd ?? ""}>
          {item.kind === "loop" ? loopNote(item) : (item.cmd ?? "")}
        </div>
      </div>
      <Metrics item={item} />
      <div className="active-actions">
        <button
          className="btn danger active-stop"
          type="button"
          aria-label={`Stop ${item.kind} ${item.name}`}
          disabled={busy}
          onClick={() => {
            void stop();
          }}
        >
          Stop
        </button>
      </div>
    </div>
  );
}

/** Running loops and monitors as ledger rows, or nothing when there are none to show. */
export function ActiveStrip({ items }: { items: readonly ActiveItem[] }) {
  if (items.length === 0) {
    return null;
  }
  const loops = items.filter((item) => item.kind === "loop").length;
  const watches = items.length - loops;
  const attention = items.filter((item) => item.status !== "running").length;
  const parts = [`${loops} ${loops === 1 ? "loop" : "loops"}`, `${watches} ${watches === 1 ? "monitor" : "monitors"}`];
  if (attention > 0) {
    parts.push(`${attention} need attention`);
  }
  return (
    <section id="active-strip" aria-label="Loops and monitors">
      <div className="section-head">
        <h2 className="section-title">Loops and monitors</h2>
        <span className="section-meta">{parts.join(" · ")}</span>
      </div>
      <PanelBox className="active-ledger">
        <div role="list" className="active-ledger-list">
          {items.map((item) => (
            <ActiveRow key={item.id} item={item} />
          ))}
        </div>
      </PanelBox>
    </section>
  );
}
