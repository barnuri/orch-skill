import type { RunMessage } from "../../shared/types/run-message";
import type { RunNode } from "../../shared/types/run-node";
import type { RunState } from "../../shared/types/run-state";
import { fmtTokens } from "./format";
import { mainStatus, type RunWithCoordinator } from "./run-table";
import type { Segment } from "../runs/NodeStatusLine";

/** The id the graph box and the pinned table row select; the panel recognises it. */
export const ORCH_SELECT_ID = "__main__";
/** The `node tell` / activity target name of the orchestrator. */
export const ORCH_TARGET = "coordinator";
/** The inbox folder (`inbox/orch`) the orchestrator reads. */
export const ORCH_BOX = "orch";

/** Most messages of the orchestrator thread kept in the stream. */
const THREAD_LIMIT = 12;

export function isOrchSelection(id: string | null): boolean {
  return id === ORCH_SELECT_ID;
}

/** The orchestrator as a RunNode, so NodePanel and its parts render it like any node. */
export function orchestratorNode(run: RunWithCoordinator): RunNode {
  const main = mainStatus(run);
  const coord = run.coordinator;
  return {
    id: ORCH_TARGET,
    label: "orchestrator",
    status: main === "running" ? "running" : main === "unreachable" ? "stale" : "done",
    profile: coord?.harness ?? null,
    adapter: coord?.harness ?? null,
    model: (run.orchestrator_state ?? run.coordinator_state)?.model ?? null,
    job_id: null,
    session: coord?.session_id ?? run.harness_session,
    started: run.started,
    finished: run.finished,
    error: null,
    log_tail: [],
  } as RunNode;
}

/** Messages to or from the orchestrator, oldest first. Mirror notes of the user's own node tells are left out. */
export function orchThread(messages: readonly RunMessage[]): RunMessage[] {
  return messages
    .filter((m) => (m.to === ORCH_BOX || m.from === ORCH_BOX) && !(m.from === "user" && m.text.startsWith("user -> ")))
    .filter((m) => m.kind !== "ask")
    .slice(-THREAD_LIMIT);
}

/** Open asks nodes put to the orchestrator, oldest first. */
export function orchAsks(messages: readonly RunMessage[]): RunMessage[] {
  return messages.filter((m) => m.kind === "ask" && m.to === ORCH_BOX && (m.answer === null || m.answer === undefined));
}

const shortId = (id: string, keep = 4): string => (id.length <= keep + 1 ? id : `…${id.slice(-keep)}`);

/** The status line segments of the orchestrator: session, harness, model, context tokens, registered or not, pending asks. */
export function orchestratorSegments(run: RunState, contextTokens: number | null | undefined): Segment[] {
  const state = (run as RunWithCoordinator).orchestrator_state ?? (run as RunWithCoordinator).coordinator_state ?? null;
  const out: Segment[] = [];
  const session = state?.session_id ?? (run as RunWithCoordinator).coordinator?.session_id ?? "";
  const main = mainStatus(run as RunWithCoordinator);
  out.push({ key: "state", text: main, tone: `${main === "running" ? "st-running" : main === "idle" ? "st-waiting" : "o-stale"} node-statusline-state` });
  out.push({ key: "harness", text: state?.harness || "harness unknown", tone: "t-profile" });
  out.push({ key: "model", text: state?.model ?? "model unknown", tone: "t-model", title: state?.model ?? undefined });
  out.push({ key: "context", text: contextTokens === null || contextTokens === undefined ? "context —" : `context ${fmtTokens(contextTokens)}`, tone: "t-tokens", title: "input + cache-read tokens of the newest assistant message" });
  out.push(
    state === null
      ? { key: "link", text: "not registered", tone: "o-none", title: "run set coordinator has not run for this run" }
      : state.reachable
        ? { key: "link", text: state.pane_id === "" ? "registered · session" : `registered · ${state.pane_id}`, tone: "o-ok" }
        : { key: "link", text: "unreachable", tone: "o-stale", title: state.unreachable_reason ?? undefined },
  );
  const asks = state?.pending_asks ?? 0;
  out.push({ key: "asks", text: `${asks} pending ${asks === 1 ? "ask" : "asks"}`, tone: asks > 0 ? "o-stale" : "t-muted" });
  if (session !== "") {
    out.push({ key: "session", text: `session ${shortId(session)}`, tone: "t-id", title: session, copy: session });
  }
  return out;
}
