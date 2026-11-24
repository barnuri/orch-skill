import { useState } from "react";
import { MARKER_ICON } from "../lib/node-markers";
import { NodeMenu } from "./NodeMarkers";
import { useNodeMarkers } from "./node-marker-context";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { isStarting } from "../../shared/node-timing";
import type { TimedRun } from "../../shared/node-timing";
import { api } from "../api/client";
import { describeFailure } from "../api/result";
import { refetchRun } from "./run-actions";
import { markFor, MARKS } from "../lib/harness-marks";
import { NODE_H, NODE_W, ORCH_NODE_H, ORCH_NODE_W, layoutDag } from "../lib/dag-layout";
import type { DagLayout } from "../lib/dag-layout";
import { truncate } from "../lib/format";
import { AFTER_THE_FACT, STALE_TITLE, UNOWNED_TITLE, healthClass, lastActivity, needsUserReason, nodeFlags, ownerChip, resultChip, resultLabel } from "../lib/node-flags";
import { latestActivityLine } from "../lib/owner-activity";
import { useCachedNodeActivity } from "./queries";
import { modelPick } from "../lib/model-pick";
import { familyOf, iconModelOf } from "../lib/model-family";
import { META_MAX_CHARS, attemptLine, cardUsageMetric, durationMetric, modelMetric, peakContextMetric, roleTierMetric, statusLine, waitReason, waitingOnDeps } from "../lib/node-metrics";
import type { Metric } from "../lib/node-metrics";
import { profilePalette } from "../lib/profile-color";
import { Ago } from "./RunActivity";
import { ModelIcon } from "./ModelIcon";
import { useNow } from "./use-now";
import { paletteClass } from "../../shared/status-palette";

type Point = { x: number; y: number };

const HARNESS_MARK_SIZE = 15;
const LABEL_MAX = 19;
const STATUS_Y = 42;
const MODEL_Y = 58;
const METRICS_RULE_Y = 67;
const DURATION_Y = 83;
const USAGE_Y = 98;
const ROLE_TIER_Y = 113;
const HEALTH_Y = 129;
const RETRY_W = 52;
const META_LEFT_X = 14;
const MODEL_ICON_GAP = 16;
const MODEL_ICON_GAP_CHARS = 2;
const META_RIGHT_X = NODE_W - 12;
const STAGE_LABEL_Y = 16;

/** Peak context of the node, at the right edge of the usage row; the warning colour above 200k. */
function ContextChip({ node }: { node: RunNode }) {
  const m = peakContextMetric(node);
  if (m === null) {
    return null;
  }
  return (
    <g className={m.over ? "context-chip over" : "context-chip"} transform={`translate(${META_RIGHT_X - 58} ${USAGE_Y - 11})`} data-peak-context={m.over ? "over" : "ok"}>
      <title>{m.title}</title>
      <rect width={58} height={15} rx={7.5} />
      <text x={29} y={11} textAnchor="middle">
        {m.text}
      </text>
    </g>
  );
}

/** A node blocked on the user carries its own "needs you" chip, the reason in its tooltip. */
function NeedsYouChip({ reason }: { reason: string }) {
  return (
    <g className="needs-you-chip" transform={`translate(${META_LEFT_X} ${HEALTH_Y - 11})`} data-needs-user="">
      <title>{`needs you: ${reason}`}</title>
      <rect width={62} height={15} rx={7.5} />
      <text x={31} y={11} textAnchor="middle">
        needs you
      </text>
    </g>
  );
}

/** Verdict chip of a finished node: green full, amber partial, red blocked, grey unknown. The summary is the tooltip. */
function ResultChipView({ node }: { node: RunNode }) {
  const chip = resultChip(node);
  if (chip === null) {
    return null;
  }
  return (
    <g className={`result-chip result-${chip.verdict} ${paletteClass(chip.verdict)}`.trim()} transform={`translate(${META_RIGHT_X - 60} ${STATUS_Y - 11})`} data-result={chip.verdict} role="img" aria-label={resultLabel(chip.verdict)}>
      <title>{[chip.summary, chip.followUp !== "" && chip.followUp.toLowerCase() !== "none" ? `follow_up: ${chip.followUp}` : ""].filter((t) => t !== "").join("\n") || chip.verdict}</title>
      <rect width={60} height={15} rx={7.5} />
      <text x={30} y={11} textAnchor="middle">
        {chip.verdict}
      </text>
    </g>
  );
}

/** Inline Retry on an error node's card. A click here never selects the node (it stops at the button). */
function GraphRetry({ node, runId }: { node: RunNode; runId: string }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const [why, setWhy] = useState("");
  if (node.status !== "error") {
    return null;
  }
  const label = state === "busy" ? "…" : state === "failed" ? "failed" : "Retry";
  return (
    <g
      className={`graph-retry${state === "busy" ? " is-busy" : ""}${state === "failed" ? " is-failed" : ""}`}
      role="button"
      aria-label={`Retry ${node.id}`}
      aria-disabled={state === "busy"}
      tabIndex={0}
      transform={`translate(${NODE_W - RETRY_W - 8} ${HEALTH_Y - 14})`}
      onClick={(event) => {
        event.stopPropagation();
        if (state === "busy") {
          return;
        }
        setState("busy");
        void api.retryNode(runId, node.id).then((result) => {
          if (result.kind === "ok") {
            setState("idle");
            void refetchRun(runId);
          } else {
            setWhy(describeFailure(result, "Retry failed"));
            setState("failed");
          }
        });
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.stopPropagation();
        }
      }}
    >
      <title>{state === "failed" ? why : `Retry ${node.id}`}</title>
      <rect width={RETRY_W} height={18} rx={4} className="graph-retry-box" />
      <text x={RETRY_W / 2} y={13} textAnchor="middle">{label}</text>
    </g>
  );
}

/** Markers on the card's top edge (icon and word, straddling the border) and the "⋯" menu in the top right corner. */
function CardMarkers({ node, runId }: { node: RunNode; runId: string }) {
  const markers = useNodeMarkers(node.id);
  let x = META_LEFT_X;
  return (
    <>
      {markers.map((m) => {
        const w = 18 + m.word.length * 6;
        const at = x;
        x += w + 4;
        return (
          <g key={m.code} className={`card-marker is-${m.tone}`} transform={`translate(${at} -9)`} data-marker={m.code}>
            <title>{m.title}</title>
            <rect width={w} height={15} rx={7.5} />
            <text x={7} y={11}>{`${MARKER_ICON[m.code]} ${m.word}`}</text>
          </g>
        );
      })}
      <foreignObject className="card-menu" x={NODE_W - 28} y={-11} width={160} height={150}>
        <NodeMenu runId={runId} node={node} markers={markers} />
      </foreignObject>
    </>
  );
}

function Health({ node, runId }: { node: RunNode; runId: string }) {
  const flags = nodeFlags(node);
  const chip = ownerChip(node);
  const cached = useCachedNodeActivity(runId, node.id);
  const latest = latestActivityLine(cached.data as never);
  const reason = needsUserReason(node);
  if (reason !== null) {
    return <NeedsYouChip reason={reason} />;
  }
  const word = flags.stale ? "stale" : flags.unowned ? "unowned" : chip !== null ? chip.text : flags.afterTheFact ? "after the fact" : "";
  const last = lastActivity(node);
  if (word === "" && last === null) {
    return null;
  }
  return (
    <text className={healthClass(node)} x={META_LEFT_X} y={HEALTH_Y}>
      {last === null ? word : <Ago iso={last} prefix={word !== "" ? `${word} · ` : ""} />}
      {word === "" && latest === null ? null : (
        <title>{[flags.unowned ? UNOWNED_TITLE : word === "after the fact" ? AFTER_THE_FACT : chip !== null ? chip.title : word !== "" ? STALE_TITLE : "", latest ?? ""].filter((t) => t !== "").join("\n")}</title>
      )}
    </text>
  );
}

/** The node's harness: `adapter` is authoritative once dispatched; a waiting node falls back to its profile's. */
function harnessOf(node: RunNode, byProfile: Record<string, string>): string | null {
  if (node.adapter !== null && node.adapter !== "") {
    return node.adapter;
  }
  if (node.profile !== null && node.profile !== "") {
    return byProfile[node.profile] ?? null;
  }
  return null;
}

export function profileKey(node: RunNode): string | null {
  if (node.profile !== null && node.profile !== "") {
    return node.profile;
  }
  if (node.adapter !== null && node.adapter !== "") {
    return node.adapter;
  }
  return null;
}

/** The duration of a node; a running one ticks off the shared ticker, every other state is static. */
export function useNodeDuration(node: RunNode, run?: TimedRun | null) {
  useNow(node.status === "running" && (node.started !== null || isStarting(node)));
  return durationMetric(node, run);
}

function HarnessGlyph({ id, x, y, size }: { id: string; x: number; y: number; size: number }) {
  const mark = markFor(id);
  const known = MARKS[id] !== undefined;
  const scale = size / mark.box;
  return (
    <g
      className={`harness-mark ${mark.filled ? "is-filled" : "is-stroked"} ${known ? `mark-${id}` : "mark-unknown"}`}
      transform={`translate(${x} ${y}) scale(${scale.toFixed(4)})`}
    >
      {mark.paths.map((d) => (
        <path key={d} d={d} />
      ))}
      {(mark.rects ?? []).map((rect) => (
        <rect key={`${rect.x}-${rect.y}`} x={rect.x} y={rect.y} width={rect.width} height={rect.height} rx={rect.rx} />
      ))}
      {(mark.circles ?? []).map((circle) => (
        <circle key={`${circle.cx}-${circle.cy}`} cx={circle.cx} cy={circle.cy} r={circle.r} />
      ))}
    </g>
  );
}

function MetricText({ metric, base, x, y, max, anchor = "start" }: { metric: Metric; base: string; x: number; y: number; max: number; anchor?: "start" | "end" }) {
  return (
    <text className={`${base}${metric.present ? "" : " missing"}`} x={x} y={y} textAnchor={anchor}>
      <title>{metric.title}</title>
      {truncate(metric.text, max)}
    </text>
  );
}

function edgeD(from: Point, fromW: number, fromH: number, to: Point): string {
  const x1 = from.x + fromW;
  const y1 = from.y + fromH / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const cx = (x1 + x2) / 2;
  return `M${x1} ${y1} C${cx} ${y1} ${cx} ${y2} ${x2} ${y2}`;
}

function OrchNode({ run, pos }: { run: RunState; pos: Point }) {
  const session = run.harness_session !== "" ? truncate(run.harness_session, 14) : "orchestrator";
  const cx = ORCH_NODE_W / 2;
  const cy = ORCH_NODE_H / 2 - 6;
  return (
    <g className={`graph-orch orch-root ${run.status}`} transform={`translate(${pos.x} ${pos.y})`} role="img" aria-label={`orch orchestrator, run ${run.status}`}>
      <rect className="orch-frame" width={ORCH_NODE_W} height={ORCH_NODE_H} rx={8} />
      <g className="orch-icon" transform={`translate(${cx} ${cy})`}>
        <circle className="hub" cx={0} cy={0} r={5} />
        {(
          [
            [-14, -10],
            [14, -10],
            [0, 14],
          ] as const
        ).map(([sx, sy]) => (
          <g key={`${sx},${sy}`}>
            <line className="spoke" x1={0} y1={0} x2={sx} y2={sy} />
            <circle className="sat" cx={sx} cy={sy} r={3.5} />
          </g>
        ))}
      </g>
      <text className="orch-sub" x={cx} y={ORCH_NODE_H - 24} textAnchor="middle">
        {session}
      </text>
      <text className="orch-title" x={cx} y={ORCH_NODE_H - 10} textAnchor="middle">
        orch
      </text>
    </g>
  );
}

interface NodeCardProps {
  node: RunNode;
  pos: Point;
  selected: boolean;
  isCyclic: boolean;
  onSelect: (nodeId: string) => void;
  palette: ReturnType<typeof profilePalette>;
  harnessByProfile: Record<string, string>;
  maxAttempts: number;
  runId: string;
  /** The run's pause fields, so a duration leaves paused stretches out. */
  run?: TimedRun | null;
  /** Ids of the unfinished nodes this one waits for. */
  waitingOn?: string[];
}

/**
 * One node card. Up to seven rows (label, status and attempt, model, duration, usage and cost,
 * role, tier and effort, health): the role row holds only known values and is left out when none is.
 */
export function NodeCard({ node, pos, selected, isCyclic, onSelect, palette, harnessByProfile, maxAttempts, runId, run, waitingOn = [] }: NodeCardProps) {
  const label = node.label || node.id;
  const profile = profileKey(node);
  const harness = harnessOf(node, harnessByProfile);
  const pick = modelPick(node);
  const model = modelMetric(node, META_MAX_CHARS);
  const usage = cardUsageMetric(node);
  const duration = useNodeDuration(node, run);
  const attempt = attemptLine(node, maxAttempts);
  const roleTier = roleTierMetric(node);
  const wait = waitReason(node, waitingOn, META_MAX_CHARS);
  const style = profile === null ? undefined : ({ "--profile-accent": palette.accent(profile), "--profile-soft": palette.soft(profile) } as React.CSSProperties);
  const aria = `${label}, ${node.status}${profile !== null ? `, ${profile}` : ""}${harness !== null ? `, ${harness}` : ""}, ${
    model.present ? `model ${model.text}` : model.text
  }${pick?.tier != null ? `, tier ${pick.tier}` : ""}, ${duration.text}, ${usage.text}${roleTier.present ? `, ${roleTier.text}` : ""}, ${attempt}${needsUserReason(node) !== null ? ", needs you" : ""}`;
  const autoTitle = pick?.isAuto === true ? `${pick.isExpected ? "expected " : ""}${[pick.model, pick.tier, pick.role, pick.reason].filter((part) => part !== null).join(" · ")}` : null;
  return (
    <g
      className={`node task-node ${node.status} ${paletteClass(node.status)}${isStarting(node) ? " is-starting" : ""}${selected ? " selected" : ""}${profile !== null ? " has-profile" : ""}${nodeFlags(node).stale ? " is-stale" : ""}`}
      transform={`translate(${pos.x} ${pos.y})`}
      tabIndex={0}
      role="button"
      aria-label={aria}
      style={style}
      data-profile={profile ?? undefined}
      data-node-id={node.id}
      onClick={() => {
        onSelect(node.id);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <rect className="frame" width={NODE_W} height={NODE_H} rx={6} />
      <rect className="mark" x={0} y={0} width={5} height={NODE_H} rx={6} />
      <text className="label" x={14} y={24}>
        {truncate(label, LABEL_MAX)}
      </text>
      {harness !== null ? <HarnessGlyph id={harness} x={NODE_W - HARNESS_MARK_SIZE - 9} y={8} size={HARNESS_MARK_SIZE} /> : null}
      <text className="st" x={META_LEFT_X} y={STATUS_Y}>
        {wait === null ? statusLine(node, maxAttempts) : wait.text}
        {wait === null ? null : <title>{wait.title}</title>}
      </text>
      <ResultChipView node={node} />
      <ModelIcon family={familyOf(iconModelOf(node))} x={META_LEFT_X} y={MODEL_Y - 10} />
      <MetricText metric={model} base={pick?.isAuto === true ? "model auto" : "model"} x={META_LEFT_X + MODEL_ICON_GAP} y={MODEL_Y} max={META_MAX_CHARS - MODEL_ICON_GAP_CHARS} />
      {autoTitle === null ? null : <title>{autoTitle}</title>}
      <line className="metrics-rule" x1={META_LEFT_X} y1={METRICS_RULE_Y} x2={META_RIGHT_X} y2={METRICS_RULE_Y} />
      <MetricText metric={duration} base="metric dur" x={META_LEFT_X} y={DURATION_Y} max={META_MAX_CHARS} />
      <MetricText metric={usage} base="metric cost" x={META_LEFT_X} y={USAGE_Y} max={META_MAX_CHARS} />
      <ContextChip node={node} />
      {roleTier.present ? <MetricText metric={roleTier} base="metric role" x={META_LEFT_X} y={ROLE_TIER_Y} max={META_MAX_CHARS} /> : null}
      <Health node={node} runId={runId} />
      <CardMarkers node={node} runId={runId} />
      <GraphRetry node={node} runId={runId} />
      {isCyclic ? (
        <text className="cycle" x={NODE_W - 8} y={14} textAnchor="end">
          cycle
        </text>
      ) : null}
    </g>
  );
}

interface GraphSvgProps {
  run: RunState;
  layout: DagLayout;
  selectedId: string | null;
  onSelect: (nodeId: string) => void;
  harnessByProfile: Record<string, string>;
  maxAttempts: number;
}

/** The run's DAG: orch coordinator first, then task nodes coloured by profile, in layered stages. */
export function GraphSvg({ run, layout, selectedId, onSelect, harnessByProfile, maxAttempts }: GraphSvgProps) {
  const palette = profilePalette(run.nodes.map(profileKey).filter((name): name is string => name !== null));
  const doneIds = new Set(run.nodes.filter((node) => node.status === "done").map((node) => node.id));
  return (
    <svg width={layout.width} height={layout.height} role="img" aria-label="Task graph">
      {layout.stages.length < 2
        ? null
        : layout.stages.map((stage) => (
            <text key={stage.index} className="stage-label" x={stage.x + 2} y={STAGE_LABEL_Y}>
              {stage.count > 1 ? `stage ${stage.index + 1} · ${stage.count} parallel` : `stage ${stage.index + 1}`}
            </text>
          ))}
      {layout.orch === null
        ? null
        : layout.entryIds.map((id) => {
            const to = layout.pos[id];
            return to === undefined || layout.orch === null ? null : <path key={`orch-${id}`} className="edge" d={edgeD(layout.orch, ORCH_NODE_W, ORCH_NODE_H, to)} />;
          })}
      {run.edges.map(([fromId, toId]) => {
        const from = layout.pos[fromId];
        const to = layout.pos[toId];
        if (from === undefined || to === undefined) {
          return null;
        }
        return <path key={`${fromId}>${toId}`} className={doneIds.has(fromId) ? "edge done" : "edge"} d={edgeD(from, NODE_W, NODE_H, to)} />;
      })}
      {layout.orch === null ? null : <OrchNode run={run} pos={layout.orch} />}
      {run.nodes.map((node) => {
        const pos = layout.pos[node.id];
        return pos === undefined ? null : (
          <NodeCard
            key={node.id}
            node={node}
            pos={pos}
            selected={selectedId === node.id}
            isCyclic={layout.cyclic.includes(node.id)}
            onSelect={onSelect}
            palette={palette}
            harnessByProfile={harnessByProfile}
            maxAttempts={maxAttempts}
            runId={run.run_id}
            run={run}
            waitingOn={waitingOnDeps(run, node.id)}
          />
        );
      })}
    </svg>
  );
}
