import { Suspense, lazy, useState } from "react";
import type { ChatPart } from "../../shared/chat-parts";
import { formatDuration } from "../lib/duration";
import { CopyButton } from "./CopyButton";
import { TodoList } from "./Todos";

const DiffView = lazy(() => import("./DiffView"));

type ToolPart = Extract<ChatPart, { type: "tool-call" }>;
const OUTPUT_LIMIT = 1200;

export function toolDurationMs(part: ToolPart, now: number): number | null {
  if (part.started_at === undefined) {
    return null;
  }
  const start = Date.parse(part.started_at);
  const end = part.ended_at !== undefined ? Date.parse(part.ended_at) : part.state === "running" ? now : NaN;
  return Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, end - start);
}

/** One tool call as a collapsible card: name, short input, status, duration; the body holds input (or todos, or a diff) and output. */
export function ToolCard({ part, extra, now }: { part: ToolPart; extra: ChatPart[]; now: number }) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const ms = toolDurationMs(part, now);
  const todo = extra.find((p) => p.type === "todo");
  const diff = extra.find((p) => p.type === "diff");
  const output = part.output ?? "";
  const shown = all || output.length <= OUTPUT_LIMIT ? output : output.slice(0, OUTPUT_LIMIT);
  const input = part.input === undefined || part.input === null ? "" : typeof part.input === "string" ? part.input : JSON.stringify(part.input, null, 2);
  return (
    <div className={`tool-card is-${part.state}`} data-testid="tool-card" data-state={part.state}>
      <button type="button" className="tool-toggle" aria-expanded={open} onClick={() => { setOpen(!open); }}>
        <span className="tool-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <span className="tool-name mono">{part.name}</span>
        {part.summary !== "" ? <span className="tool-short mono">{part.summary}</span> : null}
        <span className={`tool-state is-${part.state}`} data-testid="tool-state">{part.state}</span>
        {ms !== null ? <span className="tool-dur mono" data-testid="tool-duration">{ms < 1000 ? `${ms}ms` : formatDuration(ms)}</span> : null}
      </button>
      {open ? (
        <div className="tool-card-body">
          {todo?.type === "todo" ? <TodoList items={todo.items} /> : null}
          {diff?.type === "diff" ? (
            <Suspense fallback={<pre className="tool-body">{diff.after}</pre>}>
              <DiffView path={diff.path} before={diff.before} after={diff.after} />
            </Suspense>
          ) : null}
          {todo === undefined && diff === undefined && input !== "" ? <pre className="tool-body" data-testid="tool-input">{input}</pre> : null}
          {output === "" && part.state === "running" ? <p className="tool-card-empty">Running. The output appears when the call finishes.</p> : null}
          {output === "" && part.state === "error" ? <p className="tool-card-empty">The call failed with no output. Retry the reply, or check the agent's log.</p> : null}
          {output !== "" ? (
            <div className="tool-out">
              <pre className={`tool-body${part.state === "error" ? " is-error" : ""}`} data-testid="tool-output">{shown}{shown.length < output.length ? "…" : ""}</pre>
              <div className="tool-out-actions">
                {output.length > OUTPUT_LIMIT ? <button type="button" className="link-btn" onClick={() => { setAll(!all); }}>{all ? "Show less" : "Show more"}</button> : null}
                <CopyButton text={output} label="Copy output" />
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Consecutive tool calls: one card alone, or a group that stays open while one runs and folds when all are done. */
export function ToolGroup({ calls, now }: { calls: Array<{ key: string; part: ToolPart; extra: ChatPart[] }>; now: number }) {
  const running = calls.filter((c) => c.part.state === "running").length;
  const failed = calls.filter((c) => c.part.state === "error").length;
  const [open, setOpen] = useState<boolean | null>(null);
  if (calls.length === 1) {
    const c = calls[0] as (typeof calls)[number];
    return <div className="tool-group"><ToolCard part={c.part} extra={c.extra} now={now} /></div>;
  }
  const expanded = open ?? running > 0;
  return (
    <div className="tool-group" data-testid="tool-group">
      <button type="button" className="tool-toggle tool-group-head" aria-expanded={expanded} onClick={() => { setOpen(!expanded); }}>
        <span className="tool-caret" aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        <span>{calls.length} tool calls</span>
        {running > 0 ? <span className="tool-state is-running">{running} running</span> : null}
        {failed > 0 ? <span className="tool-state is-error">{failed} failed</span> : null}
      </button>
      {expanded ? calls.map((c) => <ToolCard key={c.key} part={c.part} extra={c.extra} now={now} />) : null}
    </div>
  );
}
