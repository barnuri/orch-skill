import { useEffect, useRef, useState, Suspense, lazy } from "react";
import { loadGraphPrefs, saveGraphNodeView } from "../lib/graph-prefs";
import type { ReactNode } from "react";
import type { ChatTurn } from "../../shared/types/chat-turn";
import type { NodeCost } from "../../shared/types/node-cost";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import type { TimedRun } from "../../shared/node-timing";
import { Chip } from "../components/Chip";
import { useToast } from "../components/Toast";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { ansiSegments } from "../lib/ansi";
import { fmtTime, fmtTokens, fmtUsd } from "../lib/format";
import { AFTER_THE_FACT, UNOWNED_TITLE, handoffText, lastActivity, nodeFlags, ownerChip, ownerIdShort, ownerStateLabel, ownerText, resultChip, resultLabel } from "../lib/node-flags";
import { AGENT_SESSION_EMPTY, INLINE_EMPTY, activityLines, isInline, usesSessionActivity } from "../lib/owner-activity";
import { modelPick, pickLabel } from "../lib/model-pick";
import { actualModelMetric, aliasActual, aliasActualText, attemptLine, effortText, effortTitle, modelMetric, usageMetric, waitReason, waitingOnDeps } from "../lib/node-metrics";
import type { Metric } from "../lib/node-metrics";
import { coveredHref, coveredTarget } from "../lib/covered-node";
import { activeStageSummary, formatSelectionLine, timelineEvents } from "../lib/selection-timeline";
import { Ago } from "./RunActivity";
import { useJobChat, useJobLog, useNodeActivity } from "./queries";
import { refetchRun } from "./run-actions";
import { useNodeDuration } from "./GraphSvg";
import { NodeActions, NodeWarnings } from "./NodeActions";
import { NodeMessages } from "./NodeMessages";
import { NodeStatusLine } from "./NodeStatusLine";
import { paletteClass } from "../../shared/status-palette";

/** Lines of each earlier attempt's log kept in the panel; the full log is in Output. */
const ATTEMPT_TAIL_LINES = 8;

/** The chat renderer (Markdown, code blocks, sanitised) used for AI text; loaded on first use. */
const ChatMarkdown = lazy(() => import("../chats/Markdown"));

/** AI text in the chat renderer; ANSI text keeps terminal colours instead of Markdown escapes. */
function AiText({ text, className, plain }: { text: string; className: string; plain: string }) {
  if (text.includes("\u001b")) {
    return (
      <div className={className}>
        <pre className="chat-text"><AnsiLog text={plain} /></pre>
      </div>
    );
  }
  return (
    <div className={className}>
      <Suspense fallback={<pre className="chat-text">{plain}</pre>}>
        <ChatMarkdown text={text} />
      </Suspense>
    </div>
  );
}

/** A log with its colour: each run of text is a span, so a log line stays text and nothing is injected as HTML. */
function AnsiLog({ text }: { text: string }) {
  return (
    <>
      {ansiSegments(text).map((seg, i) => {
        const { base, rgb, bold, dim } = seg.style;
        const fg = base === null ? "" : base === 1 || base === 9 ? `ansi-error-fg-${base}` : `ansi-fg-${base}`;
        const cls = [fg, bold ? "ansi-bold" : "", dim ? "ansi-dim" : ""].filter(Boolean).join(" ");
        return cls === "" && rgb === null ? (
          seg.text
        ) : (
          <span key={i} className={cls || undefined} style={rgb !== null ? { color: rgb } : undefined}>
            {seg.text}
          </span>
        );
      })}
    </>
  );
}

function Row({ k, value, cls = "", title }: { k: string; value: ReactNode; cls?: string; title?: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={cls === "" ? undefined : cls} title={title}>
        {value}
      </dd>
    </>
  );
}

/** A row whose value may be a placeholder: muted, with the reason in its tooltip. */
function MetricRow({ k, metric, cls = "" }: { k: string; metric: Metric; cls?: string }) {
  return <Row k={k} value={metric.text} cls={`${cls}${metric.present ? "" : " missing"}`.trim()} title={metric.title} />;
}

const fmtCount = (value: number): string => (Number.isFinite(value) ? value.toLocaleString() : "—");

function CostRows({ cost }: { cost: NodeCost }) {
  return (
    <>
      <Row k="cost" value={`${fmtUsd(cost.usd)} ${cost.cost_basis} price`} />
      <Row k="tokens" value={`${fmtCount(cost.input_tokens)} in · ${fmtCount(cost.output_tokens)} out`} cls="mono" />
      {cost.cache_read_tokens > 0 || cost.cache_creation_tokens > 0 ? (
        <Row k="cache" value={`${fmtCount(cost.cache_read_tokens)} read · ${fmtCount(cost.cache_creation_tokens)} written`} cls="mono" />
      ) : null}
      {cost.models.length < 2 ? null : <Row k="models" value={cost.models.map((model) => `${model.model}  ${fmtUsd(model.usd)}`).join("\n")} cls="mono cost-models" />}
    </>
  );
}

function ReportRows({ node }: { node: RunNode }) {
  const report = node.report;
  if (report === undefined || report === null) {
    return null;
  }
  const part = (value: number | null, label: string): string | null => (value === null ? null : `${value.toLocaleString()} ${label}`);
  const tokens = [part(report.input_tokens, "in"), part(report.output_tokens, "out"), part(report.cache_read_tokens, "cache read")]
    .filter((text): text is string => text !== null)
    .join(" · ");
  return (
    <>
      <Row k="reported" value={`by the orchestrator (${report.reported_by}) at ${fmtTime(report.at)}`} />
      {report.usd === null ? null : <Row k="report cost" value={fmtUsd(report.usd)} />}
      {tokens === "" ? null : <Row k="report tokens" value={tokens} cls="mono" />}
      {report.note === null ? null : <Row k="note" value={report.note} />}
    </>
  );
}

function FlagChips({ node }: { node: RunNode }) {
  const flags = nodeFlags(node);
  const chip = ownerChip(node);
  return (
    <>
      {flags.stale ? <Chip status="stale" /> : null}
      {flags.unowned ? <Chip status="unowned" title={UNOWNED_TITLE} /> : null}
      {chip === null ? null : (
        <Chip status={chip.cls} title={chip.title}>
          {chip.text}
        </Chip>
      )}
    </>
  );
}

function ActivityRows({ node }: { node: RunNode }) {
  const flags = nodeFlags(node);
  const owner = ownerText(node);
  const last = lastActivity(node);
  return (
    <>
      {node.owner_state === undefined || node.owner_state === null ? null : <Row k="owner state" value={node.owner_state} />}
      {node.owner_reason ? <Row k="why" value={node.owner_reason} cls="missing" /> : null}
      <Row k="owner" value={owner === null ? "not recorded" : `owned by ${owner}`} cls={owner === null ? "missing" : ""} />
      {last === null ? null : (
        <Row k="activity" value={<Ago iso={last} prefix="last activity " />} />
      )}
      {node.progress ? <Row k="progress" value={node.progress} cls="mono" /> : null}
      {(node.notes ?? []).slice(-3).map((note, index) => (
        <Row key={`${note.at}-${index}`} k="note" value={`${note.text} (${fmtTime(note.at)})`} />
      ))}
      {flags.afterTheFact ? <Row k="recorded" value={AFTER_THE_FACT} cls="missing" /> : null}
    </>
  );
}

function DetailList({ node, run, maxAttempts, waitingOn = [] }: { node: RunNode; run?: TimedRun | null; maxAttempts: number; waitingOn?: readonly string[] }) {
  const duration = useNodeDuration(node, run);
  const effort = effortText(node);
  const wait = waitReason(node, waitingOn);
  const handoff = handoffText(node);
  const result = resultChip(node);
  return (
    <dl>
      <Row k="id" value={node.id} cls="mono" />
      <Row k="status" value={node.status} />
      {wait === null ? null : <Row k="why" value={wait.text} cls={`wait-reason wait-${wait.kind}`} title={wait.title} />}
      <ActivityRows node={node} />
      {actualModelMetric(node).present ? <MetricRow k="actual" metric={actualModelMetric(node)} cls="mono" /> : null}
      <MetricRow k="duration" metric={duration} />
      <MetricRow k="usage" metric={usageMetric(node)} cls="mono" />
      <Row k="attempt" value={attemptLine(node, maxAttempts)} />
      {node.role ? <Row k="role" value={node.role} /> : null}
      {node.tier ? <Row k="tier" value={node.tier} /> : null}
      {effort === null ? null : <Row k="effort" value={effort} title={effortTitle(node)} />}
      <Row k="profile" value={node.profile ?? "—"} />
      <Row k="owner id" value={ownerIdShort(node) ?? "—"} cls="mono" />
      {result === null ? null : (
        <Row
          k="result"
          value={
            <>
              <span className={`result-pill result-${result.verdict}`} role="img" aria-label={resultLabel(result.verdict)}>{result.verdict}</span>
              {result.summary === "" ? "" : ` ${result.summary}`}
              {result.followUp === "" || result.followUp.toLowerCase() === "none" ? "" : ` | follow_up: ${result.followUp}`}
            </>
          }
        />
      )}
      {handoff === null ? null : <Row k="handoff" value={handoff.text} cls={handoff.missing ? "missing" : ""} />}
      <Row k="adapter" value={node.adapter ?? "—"} />
      <Row k="job" value={node.job_id ?? "—"} cls="mono" />
      <Row k="session" value={node.session ?? "—"} cls="mono" />
      <Row k="started" value={fmtTime(node.started)} />
      <Row k="finished" value={fmtTime(node.finished)} />
      {node.cost === undefined || node.cost === null ? null : <CostRows cost={node.cost} />}
      <ReportRows node={node} />
      {node.error === null ? null : <Row k="error" value={node.error} cls="err" />}
    </dl>
  );
}

/** The model block: the model that ran, large, with how Smart Auto chose it underneath. */
function ModelBlock({ node }: { node: RunNode }) {
  const pick = modelPick(node);
  const pair = aliasActual(node);
  if (pick === null) {
    const metric = modelMetric(node);
    return (
      <section className={`model-pick${metric.present ? "" : " is-missing"}`} aria-label="Model" title={metric.title}>
        <div className="model-pick-key">Model</div>
        <div className={`model-pick-name mono${metric.present ? "" : " missing"}`}>{metric.text}</div>
      </section>
    );
  }
  const facts = [pick.tier !== null ? `tier ${pick.tier}` : null, pick.role, pick.reason].filter((part): part is string => part !== null);
  return (
    <section className={`model-pick${pick.isAuto ? " is-auto" : ""}`} aria-label="Model">
      <div className="model-pick-key">{pick.isAuto ? (pick.isExpected ? "Smart Auto · expected" : "Smart Auto picked") : "Model"}</div>
      <div className="model-pick-name mono" title={pair === null ? pick.model : `${pair.alias} → ${pair.actual}`}>
        {pair === null ? pickLabel(pick) : aliasActualText(pair)}
      </div>
      {facts.length > 0 ? <div className="model-pick-facts">{facts.join(" · ")}</div> : null}
      {pick.selector !== null ? <div className="model-pick-sel mono">{`via ${pick.selector}`}</div> : null}
    </section>
  );
}

function compactCost(cost: NodeCost | null | undefined): string {
  if (cost === undefined || cost === null) {
    return "no usage reported";
  }
  if (Number.isFinite(cost.usd) && cost.usd > 0) {
    return fmtUsd(cost.usd);
  }
  const tokens = cost.input_tokens + cost.output_tokens + cost.cache_read_tokens + cost.cache_creation_tokens;
  return tokens > 0 ? fmtTokens(tokens) : "no usage reported";
}

function Attempts({ node }: { node: RunNode }) {
  const attempts = node.attempts ?? [];
  if (attempts.length === 0) {
    return null;
  }
  return (
    <section className="attempts" aria-label="Attempts history">
      <h3 className="panel-log-title">{`Attempts — ${attempts.length}`}</h3>
      <ol>
        {attempts.map((attempt, index) => {
          const tail = (attempt.log_tail ?? []).slice(-ATTEMPT_TAIL_LINES);
          const lines = [
            attempt.profile ?? attempt.adapter ?? "—",
            attempt.model_id ?? attempt.model ?? "model not reported",
            attempt.actual_model != null && attempt.actual_model !== (attempt.model_id ?? attempt.model) ? `→ ${attempt.actual_model}` : "",
            compactCost(attempt.cost),
            attempt.finished === null ? "not finished" : fmtTime(attempt.finished),
            attempt.error,
            attempt.retry_mode ?? "",
            attempt.retry_session ?? "",
            attempt.reason ?? "",
          ].filter((part): part is string => typeof part === "string" && part !== "");
          return (
            <li key={index} className={`attempt-item${attempt.error !== null ? " has-error" : ""}`}>
              <div className="attempt-head">
                <span className="attempt-no mono">{`#${index + 1}`}</span>
                <span className="attempt-meta mono">{lines.join(" · ")}</span>
              </div>
              {tail.length > 0 ? <pre className="transcript attempt-tail"><AnsiLog text={tail.join("\n")} /></pre> : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function Selections({ node }: { node: RunNode }) {
  const history = node.selection_history ?? [];
  if (history.length === 0) {
    return null;
  }
  const events = timelineEvents(history);
  const picked = node.actual_model ?? node.model_id ?? node.model ?? "no model yet";
  const switches = Math.max(0, history.length - 1);
  const header = [node.requested_selector ?? "", activeStageSummary(node) ?? ""].filter((part) => part !== "").join(" · ");
  return (
    <details className="disclosure selections" aria-label="Model selections">
      <summary>
        <span className="disclosure-title">Selections</span>
        <span className="disclosure-sum mono">{`${picked} · ${switches} ${switches === 1 ? "switch" : "switches"}`}</span>
      </summary>
      {header === "" ? null : <p className="hint">{header}</p>}
      <ol>
        {events.map((event) => (
          <li key={event.seq} className="selection-item">
            <div className="mono">{formatSelectionLine(event)}</div>
            <div className="hint">{fmtTime(event.ts)}</div>
          </li>
        ))}
      </ol>
    </details>
  );
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Only claude is resumable by an id orch chose; for anything else the honest offer is the log. */
function resumeCommand(node: RunNode, session: string | null): string | null {
  return session === null || session === "" || node.adapter !== "claude" ? null : `claude --resume ${session}`;
}

const LOG_WINDOW_LINES = 200;

export function transcriptLines(text: string): string[] {
  const lines = text.replace(/\r/g, "").split("\n");
  return lines.slice(-LOG_WINDOW_LINES);
}

export function isNearBottom(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
  return scrollHeight - scrollTop - clientHeight < 24;
}

export function toolLine(text: string): boolean {
  const trimmed = text.trim();
  return /^(?:tool|function)[\s:_-]/i.test(trimmed)
    || /^\s*[⏺◆●]\s*(?:tool|function)/i.test(trimmed)
    || /^\[[^\]]+\]\s+(?:Read|Write|Edit|Glob|Grep|Bash|Shell|Tool)/i.test(trimmed);
}

function JobTranscript({ text }: { text: string }) {
  const list = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const lines = transcriptLines(text);
  const atBottom = (element: HTMLDivElement): boolean => isNearBottom(element.scrollHeight, element.scrollTop, element.clientHeight);
  useEffect(() => {
    const element = list.current;
    if (following && element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  }, [text, following]);
  const jumpToBottom = (): void => {
    const element = list.current;
    if (element !== null) {
      element.scrollTop = element.scrollHeight;
      setFollowing(true);
    }
  };
  return (
    <div className="job-transcript-wrap">
      <div
        className="job-transcript"
        role="log"
        aria-label="Recent job log"
        ref={list}
        onScroll={(event) => {
          const nowAtBottom = atBottom(event.currentTarget);
          if (following !== nowAtBottom) {
            setFollowing(nowAtBottom);
          }
        }}
      >
        {lines.map((line, index) => (
          <div key={`${index}-${line}`} className={toolLine(line) ? "job-message is-tool mono" : "job-message mono"}>
            {line === "" ? " " : <AnsiLog text={line} />}
          </div>
        ))}
      </div>
      {following ? null : <button className="btn job-jump-bottom" type="button" onClick={jumpToBottom}>Jump to bottom</button>}
    </div>
  );
}

function ChatTurns({ turns, truncated, node }: { turns: readonly ChatTurn[]; truncated: boolean; node: RunNode }) {
  const list = useRef<HTMLDivElement>(null);
  // Oldest first, like a terminal: follow the newest turn when the count changes.
  useEffect(() => {
    if (list.current !== null) {
      list.current.scrollTop = list.current.scrollHeight;
    }
  }, [turns.length]);
  const model = node.actual_model ?? node.model_id ?? node.model ?? "model not reported";
  return (
    <div className="chat-turns term-log" id="node-chat-list" ref={list} role="log" aria-label="Session chat">
      {truncated ? <p className="term-dim chat-truncated">Older turns were dropped: the transcript is too long.</p> : null}
      {turns.length === 0 ? <p className="term-dim">The transcript holds no turns yet.</p> : null}
      {turns.map((turn) => (
        <article key={turn.id} className={`chat-turn is-${turn.role}`}>
          {turn.text === "" ? null : <AiText className={turn.role === "user" ? "term-user" : "ai-text"} text={turn.text} plain={turn.text} />}
          {turn.tools.length === 0 ? null : (
            <div className="chat-tools">
              {turn.tools.map((tool, index) => (
                <div key={index} className="chat-tool">
                  <span className="chat-tool-name">{tool.name}</span>
                  {tool.summary === "" ? null : <span className="chat-tool-summary mono">{tool.summary}</span>}
                </div>
              ))}
            </div>
          )}
          {turn.role === "assistant" ? (
            <div className="term-meta">{[node.profile ?? "agent", model, turn.timestamp === null ? "" : fmtTime(turn.timestamp)].filter((part) => part !== "").join(" · ")}</div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

/** `+ Tokens: ...` footer under the stream, the way opencode prints a finished turn. */
function TokensLine({ node }: { node: RunNode }) {
  const cost = node.cost;
  if (cost === undefined || cost === null) {
    return null;
  }
  const part = (n: number, label: string): string => `${n.toLocaleString()} ${label}`;
  return <div className="term-meta term-tokens">{`+ Tokens: ${[part(cost.input_tokens, "in"), part(cost.output_tokens, "out"), part(cost.cache_read_tokens, "cache read")].join(" · ")}`}</div>;
}

/** Shape of the real content while the first fetch runs. */
function TermSkeleton({ label }: { label: string }) {
  return (
    <div className="term-skeleton" role="status" aria-label={`${label}…`}>
      {[72, 48, 86, 36, 60].map((w, i) => (
        <span key={i} className="term-skel-line" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}

function CopyButton({ command }: { command: string }) {
  const toast = useToast();
  return (
    <button
      className="btn copy-cmd"
      type="button"
      title="Copy to clipboard"
      onClick={() => {
        navigator.clipboard.writeText(command).then(
          () => {
            toast("ok", "Command copied");
          },
          () => {
            toast("error", "Could not copy — select the text instead");
          },
        );
      }}
    >
      <span className="mono copy-cmd-text">{command}</span>
      <span>copy</span>
    </button>
  );
}

/** The whole session of one node: the conversation its harness had (default) or the raw output, plus the resume command. */
function NodeSession({ node }: { node: RunNode }) {
  const jobId = node.job_id !== null && node.job_id !== "" ? node.job_id : null;
  const log = useJobLog(jobId);
  const chatQuery = useJobChat(jobId);
  const [picked, setPicked] = useState<"chat" | "output" | null>(() => loadGraphPrefs().nodeView);
  const chat = chatQuery.data ?? null;
  const chatChecked = jobId === null || chatQuery.isError || chat !== null;
  const view = jobId === null || (chatChecked && chat === null) ? "output" : (picked ?? "chat");
  const envelope = log.data ?? null;

  let heading: string;
  if (view === "chat") {
    heading = chat === null ? "Session" : `Session — ${chat.turns.length} turn${chat.turns.length === 1 ? "" : "s"}, newest first`;
  } else if (envelope === null) {
    heading = node.log_tail.length > 0 ? `Session — last ${node.log_tail.length} lines` : "Session";
  } else {
    const lines = envelope.text === "" ? 0 : envelope.text.split("\n").length;
    const size = fmtBytes(envelope.bytes);
    heading = envelope.truncated ? `Session — last ${size} of ${lines} lines` : `Session — ${lines} lines, ${size}`;
  }

  let body: ReactNode;
  if (view === "chat") {
    body =
      chat === null ? <TermSkeleton label="Reading the session chat" /> : <ChatTurns turns={chat.turns} truncated={chat.truncated} node={node} />;
  } else if (jobId !== null && log.isPending) {
    body = <TermSkeleton label="Reading the session" />;
  } else if (envelope !== null) {
    body = <JobTranscript text={envelope.text} />;
  } else if (node.log_tail.length > 0) {
    body = <pre className="transcript node-output"><AnsiLog text={node.log_tail.join("\n")} /></pre>;
  } else {
    body =
      jobId !== null && log.isError ? (
        <div className="term-error" role="alert">
          <span>Could not read the transcript. The server may be busy: retry in a moment.</span>
          <button className="btn" type="button" onClick={() => void log.refetch()}>
            Retry
          </button>
        </div>
      ) : (
        <p className="term-dim term-empty">{jobId === null ? "Not dispatched yet. No session to show." : "No output yet. The log tail appears after the next run sync."}</p>
      );
  }
  const command = resumeCommand(node, envelope?.session ?? node.session ?? null);
  const tab = (id: "chat" | "output", label: string, enabled: boolean) => (
    <button
      className={`btn session-tab${view === id ? " is-active" : ""}`}
      type="button"
      aria-pressed={view === id}
      disabled={!enabled}
      onClick={() => {
        setPicked(id);
        saveGraphNodeView(id);
      }}
    >
      {label}
    </button>
  );
  return (
    <section className="node-session term" aria-label="Node session">
      <div className="node-session-head">
        <h3 className="panel-log-title">{heading}</h3>
        <div className="session-tabs" role="group" aria-label="Session view">
          {tab("chat", "Chat", chat !== null)}
          {tab("output", "Output", true)}
        </div>
        {command === null ? null : <CopyButton command={command} />}
      </div>
      {body}
      <TokensLine node={node} />
    </section>
  );
}

/** The owner session's live activity: `time  kind  text`, newest at the bottom, tool lines collapsed. */
function NodeActivity({ runId, node }: { runId: string; node: RunNode }) {
  const [visible, setVisible] = useState(typeof document === "undefined" || document.visibilityState !== "hidden");
  useEffect(() => {
    const onChange = () => {
      setVisible(document.visibilityState !== "hidden");
    };
    document.addEventListener("visibilitychange", onChange);
    return () => {
      document.removeEventListener("visibilitychange", onChange);
    };
  }, []);
  const query = useNodeActivity(runId, node.id, visible, node.status === "running" || node.status === "waiting");
  const body = query.data ?? null;
  const lines = body === null ? [] : activityLines(body);
  const last = lines.length > 0 ? (lines[lines.length - 1]?.time ?? null) : null;
  const chip = ownerChip(node);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: "nearest" });
  }, [lines.length]);
  let status: ReactNode;
  if (body !== null && body.state === "unknown") {
    status = <p className="hint">opencode is unreachable: the activity cannot be read right now.</p>;
  } else if (body !== null && body.state === "gone") {
    status = <p className="hint missing">The owner session no longer exists.</p>;
  } else if (query.isError) {
    status = <p className="hint">The activity could not be read.</p>;
  } else if (body === null) {
    status = <p className="hint">Reading the owner session…</p>;
  } else if (lines.length === 0) {
    status = <p className="hint">no activity yet</p>;
  } else {
    status = null;
  }
  return (
    <section className="node-session node-activity" aria-label="Activity">
      <div className="node-session-head">
        <h3 className="panel-log-title">Activity</h3>
        {chip === null ? null : (
          <Chip status={chip.cls} title={chip.title}>
            {chip.text}
          </Chip>
        )}
        {last === null ? null : <Ago iso={last} prefix="latest activity " />}
      </div>
      <p className="hint">{AGENT_SESSION_EMPTY}</p>
      {status}
      <div className="chat-turns" role="log">
        {lines.map((line) =>
          line.kind.startsWith("tool") ? (
            <details key={line.key} className="chat-tool">
              <summary className="mono">{`${line.time === null ? "" : fmtTime(line.time)}  ${line.kind}`}</summary>
              <span className="chat-tool-summary mono">{line.text}</span>
            </details>
          ) : (
            <div key={line.key} className="mono">{`${line.time === null ? "" : fmtTime(line.time)}  ${line.kind}  ${line.text}`}</div>
          ),
        )}
        <div ref={end} />
      </div>
    </section>
  );
}

/** Work done with no job: say so, and list what the node recorded instead of showing an empty panel. */
function InlineNotes({ node }: { node: RunNode }) {
  const own = node.notes ?? [];
  const reported = node.report?.note ?? null;
  const notes = own.length === 0 && reported !== null && reported !== "" ? [{ at: node.report?.at ?? "", text: reported }] : own;
  return (
    <section className="node-session node-inline" aria-label="Inline work">
      <h3 className="panel-log-title">Session</h3>
      <p className="hint">{INLINE_EMPTY}</p>
      {node.progress ? <p className="mono">{`progress ${node.progress}`}</p> : null}
      {notes.length === 0 ? <p className="hint">No notes were recorded.</p> : null}
      <ul>
        {notes.map((note, index) => (
          <li key={`${note.at}-${index}`} className="mono">{`${fmtTime(note.at)}  ${note.text}`}</li>
        ))}
      </ul>
    </section>
  );
}

function NodeBody({ runId, node }: { runId: string; node: RunNode }) {
  if (usesSessionActivity(node)) {
    return <NodeActivity runId={runId} node={node} />;
  }
  if (isInline(node)) {
    return <InlineNotes node={node} />;
  }
  return <NodeSession key={node.job_id ?? ""} node={node} />;
}

export function RetryNodeButton({ runId, node }: { runId: string; node: RunNode }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (node.status !== "error") {
    return null;
  }
  return (
    <button
      className="btn primary"
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void api.retryNode(runId, node.id).then((result) => {
          setBusy(false);
          if (result.kind === "ok") {
            toast("ok", `Retrying ${node.id}`);
            void refetchRun(runId);
          } else {
            toast("error", describeFailure(result, "Retry failed"));
          }
        });
      }}
    >
      Retry
    </button>
  );
}

/** Node details beside the graph: the selected node's details, attempts and session. Renders nothing when no node is selected. */
export function NodePanel({ run, selectedId, maxAttempts, flash, onClose }: { run: RunState; selectedId: string | null; maxAttempts: number; flash: number; onClose?: () => void }) {
  const node = run.nodes.find((candidate) => candidate.id === selectedId);
  const panel = useRef<HTMLElement>(null);
  // The graph fills the viewport, so a freshly shown panel sits below the fold and a click looks like
  // it did nothing: scroll it just into view and replay a one-shot border flash.
  useEffect(() => {
    const element = panel.current;
    if (flash === 0 || element === null) {
      return;
    }
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    element.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "nearest" });
    element.classList.remove("just-selected");
    void element.offsetWidth;
    element.classList.add("just-selected");
  }, [flash]);
  if (node === undefined) {
    return null;
  }
  const waitingOn = waitingOnDeps(run, node.id);
  return (
    <aside className="node-terminal" id="node-panel" aria-live="polite" ref={panel}>
      <h2 className="node-panel-head">
        <span className="node-terminal-prompt" aria-hidden="true">$ node</span>
        <span className="node-panel-title">{node.label || node.id}</span>
        {node.status === "covered" ? (
          <span className="covered-panel-status">
            <Chip status="covered">covered</Chip>{" "}
            {(() => {
              const target = coveredTarget(run.run_id, node);
              return target === null ? null : <a className="covered-link" href={coveredHref(run.run_id, node) ?? undefined}>covered by {target.nodeId}</a>;
            })()}
          </span>
        ) : <Chip status={node.status} />}
        <FlagChips node={node} />
        <span className="node-panel-spacer" />
        {onClose === undefined ? null : (
          <button className="panel-close" type="button" aria-label="Close inspector" onClick={onClose}>
            ✕
          </button>
        )}
      </h2>
      <NodeWarnings node={node} />
      <NodeActions runId={run.run_id} node={node} />
      <div className="panel-grid">
        <div className="panel-details">
          <details className="disclosure node-details">
            <summary>
              <span className="disclosure-title">Details</span>
              <span className="disclosure-sum mono">{node.id}</span>
            </summary>
            <ModelBlock node={node} />
            <DetailList node={node} run={run} maxAttempts={maxAttempts} waitingOn={waitingOn} />
            <Attempts node={node} />
          </details>
          <Selections node={node} />
        </div>
      </div>
      <NodeMessages key={node.id} runId={run.run_id} node={node}>
        <NodeBody runId={run.run_id} node={node} />
      </NodeMessages>
      <NodeStatusLine node={node} run={run} maxAttempts={maxAttempts} />
    </aside>
  );
}
