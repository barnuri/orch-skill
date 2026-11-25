// Deterministic fixtures for the fast mock lane. Pure data: no imports from the server, no file reads.
// Every timestamp derives from FIXED_NOW, so snapshots and assertions never drift with the wall clock.

export const FIXED_NOW = "2026-11-20T10:00:00.000Z";
export const MOCK_HOME = "/mock/orch-home";
export const MOCK_VERSION = "0.0.0-mock";

const HARNESSES = ["claude", "cursor-agent", "opencode", "local-llm", "copilot", "pi"] as const;
const OUTCOMES = ["success", "failure", "partial"] as const;

const RUN_RUNNING_ID = "20261120-090000-a1b2";
const RUN_DONE_ID = "20261119-120000-c3d4";

const RUN_RUNNING_STATE = {
  run_id: RUN_RUNNING_ID,
  title: "Fixture: mock running run",
  harness_session: "ses_fixture_main_1",
  started: "2026-11-20T09:00:00.000Z",
  finished: null,
  status: "running",
  coordinator: { transport: "session", pane_id: "", session_id: "ses_fixture_main_1", harness: "opencode", at: "2026-11-20T09:59:00.000Z" },
  orchestrator_state: {
    transport: "session",
    pane_id: "",
    session_id: "ses_fixture_main_1",
    harness: "opencode",
    model: "claude-opus-5",
    reachable: true,
    unreachable_since: null,
    unreachable_reason: null,
    pending_asks: 1,
    last_repoint: null,
    candidates: [],
  },
  nodes: [
    {
      id: "n1",
      label: "Plan the change",
      status: "done",
      profile: "claude-default",
      adapter: "claude",
      job_id: "job-0001",
      started: "2026-11-20T09:00:05.000Z",
      finished: "2026-11-20T09:04:00.000Z",
      model: "claude-sonnet",
      model_id: "claude-sonnet",
      error: null,
      log_tail: ["plan written"],
      attempts: [],
      next_retry_at: null,
    },
    {
      id: "n2",
      label: "Implement the change",
      status: "running",
      profile: "claude-default",
      adapter: "claude",
      job_id: "job-0002",
      started: "2026-11-20T09:04:30.000Z",
      finished: null,
      model: "claude-sonnet",
      model_id: "claude-sonnet",
      error: null,
      log_tail: ["editing src/app.ts"],
      attempts: [],
      next_retry_at: null,
    },
    {
      id: "n3",
      label: "Review the change",
      status: "waiting",
      profile: "claude-default",
      adapter: null,
      job_id: null,
      started: null,
      finished: null,
      model: null,
      model_id: null,
      error: null,
      log_tail: [],
      attempts: [],
      next_retry_at: null,
    },
  ],
  edges: [
    ["n1", "n2"],
    ["n2", "n3"],
  ],
};

const RUN_DONE_STATE = {
  run_id: RUN_DONE_ID,
  title: "Fixture: mock finished run",
  harness_session: "fixture-session-2",
  started: "2026-11-19T12:00:00.000Z",
  finished: "2026-11-19T12:30:00.000Z",
  status: "done",
  nodes: [
    {
      id: "n1",
      label: "Single step",
      status: "done",
      profile: "claude-default",
      adapter: "claude",
      job_id: "job-0003",
      started: "2026-11-19T12:00:05.000Z",
      finished: "2026-11-19T12:29:00.000Z",
      model: "claude-sonnet",
      model_id: "claude-sonnet",
      error: null,
      log_tail: ["done"],
      attempts: [],
      next_retry_at: null,
    },
  ],
  edges: [],
};

function summaryOf(state: { run_id: string; title: string; status: string; started: string; finished: string | null; nodes: { status: string }[] }) {
  const counts = { waiting: 0, running: 0, done: 0, error: 0, skipped: 0 };
  for (const node of state.nodes) {
    counts[node.status as keyof typeof counts] += 1;
  }
  return {
    run_id: state.run_id,
    title: state.title,
    status: state.status,
    started: state.started,
    finished: state.finished,
    counts,
  };
}

export const RUNS: Record<string, typeof RUN_RUNNING_STATE> = {
  [RUN_RUNNING_ID]: RUN_RUNNING_STATE,
  [RUN_DONE_ID]: RUN_DONE_STATE,
};

export const RUN_EVENTS: Record<string, { n: number; at: string; kind: string; node: string | null; from: string | null; to: string | null; note: string; by: string }[]> = {
  [RUN_RUNNING_ID]: [
    { n: 1, at: "2026-11-20T09:00:00.000Z", kind: "run", node: null, from: null, to: "running", note: "run started", by: "fixture" },
    { n: 2, at: "2026-11-20T09:04:00.000Z", kind: "status", node: "n1", from: "running", to: "done", note: "plan written", by: "fixture" },
    { n: 3, at: "2026-11-20T09:04:30.000Z", kind: "status", node: "n2", from: "waiting", to: "running", note: "implementation started", by: "fixture" },
  ],
  [RUN_DONE_ID]: [
    { n: 1, at: "2026-11-19T12:00:00.000Z", kind: "run", node: null, from: null, to: "running", note: "run started", by: "fixture" },
    { n: 2, at: "2026-11-19T12:30:00.000Z", kind: "run", node: null, from: "running", to: "done", note: "run finished", by: "fixture" },
  ],
};

export const PROFILES_DOCUMENT = {
  settings: {
    default_profile: "claude-default",
    disabled_harnesses: [],
    max_parallel: 4,
    max_attempts: 5,
    max_nodes: 12,
    planner_profile: "claude-default",
    retention_days: 7,
    budget_threshold: 85,
  },
  models: {},
  profiles: {
    "claude-default": {
      harness: "claude",
      model: "claude-sonnet",
      env: {},
      enabled: true,
      usage: "both",
      description: "Fixture profile",
    },
  },
};

export const HARNESSES_ENVELOPE = {
  generated_at: FIXED_NOW,
  harnesses: HARNESSES.map((name) => ({
    name,
    enabled: name !== "pi",
    available: name === "claude",
    usage: "both",
    detail: "fixture probe",
  })),
};

export const SERVER_INFO = {
  home: MOCK_HOME,
  host: "127.0.0.1",
  port: 0,
  version: MOCK_VERSION,
  harnesses: [...HARNESSES],
  outcomes: [...OUTCOMES],
  hostname: "mock-host",
  tls: false,
};

export const BUILD_INFO = {
  stale: false,
  started_at: FIXED_NOW,
  source_newest_at: FIXED_NOW,
  pid: 0,
  version: MOCK_VERSION,
};

export const HEALTH = { ok: true, pid: 0, home: MOCK_HOME, version: MOCK_VERSION };

export const ENDPOINTS_SUPPORTED = [
  "GET /api/health",
  "GET /api/server-info",
  "GET /api/build",
  "GET /api/runs",
  "GET /api/runs/:id",
  "GET /api/runs/:id/events",
  "GET /api/active",
  "GET /api/harnesses",
  "GET /api/profiles",
  "GET /api/memory",
] as const;

export function runsList() {
  return {
    generated_at: FIXED_NOW,
    runs: [RUN_RUNNING_STATE, RUN_DONE_STATE].map(summaryOf),
  };
}

export function runDetail(id: string) {
  const state = RUNS[id];
  return state === undefined ? null : { generated_at: FIXED_NOW, run: state };
}

export function runEvents(id: string) {
  const events = RUN_EVENTS[id];
  if (events === undefined) {
    return null;
  }
  return { events, next: events.length === 0 ? 0 : events[events.length - 1].n };
}

export function profilesEnvelope() {
  return {
    document: PROFILES_DOCUMENT,
    issues: [],
    limits: { max_body_bytes: 4194304 },
    harnesses: [...HARNESSES],
  };
}

export function memoryEnvelope() {
  return {
    document: [],
    issues: [],
    limits: { max_body_bytes: 4194304 },
    outcomes: [...OUTCOMES],
  };
}

export const ACTIVE_ENVELOPE = { generated_at: FIXED_NOW, items: [] };

export const HEALTH_SUMMARY = {
  running_runs: 1,
  stalled: 0,
  dead: 0,
  unowned: 0,
  no_report: 0,
  needs_user: 0,
  ready: 1,
  flagged_runs: [],
  herdr: { state: "off", problems: [] },
};

export function runHealth(id: string) {
  if (RUNS[id] === undefined) {
    return null;
  }
  return {
    generated_at: FIXED_NOW,
    source: "fixture",
    health: {
      run: id,
      slots: 4,
      nodes: RUNS[id].nodes.map((node) => ({ id: node.id, health: node.status === "running" ? "ok" : "idle" })),
      ready: [],
    },
  };
}

/** The orchestrator's session activity for the mock lane. */
export function orchestratorActivity() {
  return {
    state: "ok",
    next: "a3",
    context_tokens: 84_200,
    messages: [
      { id: "a1", role: "user", time: "2026-11-20T09:58:00.000Z", parts: [{ kind: "text", text: "Plan the change and dispatch the nodes." }] },
      { id: "a2", role: "assistant", time: "2026-11-20T09:58:20.000Z", parts: [{ kind: "tool", tool: "bash", text: "bun skills/orch/scripts/dispatch.ts run status" }] },
      { id: "a3", role: "assistant", time: "2026-11-20T09:59:10.000Z", parts: [{ kind: "text", text: "n1 is done. n2 runs; n3 waits on it. One question from n2 is open." }] },
    ],
  };
}

/** The run inbox for the mock lane: one open ask to the orchestrator and one delivered tell. */
export function runMessages() {
  return {
    messages: [
      { id: "m1", seq: 1, from: "n2", to: "orch", kind: "ask", at: "2026-11-20T09:59:30.000Z", text: "Use the existing migration or write a new one?", status: "pending", delivered_at: null, via: null, answer: null },
      { id: "m2", seq: 2, from: "user", to: "orch", kind: "tell", at: "2026-11-20T09:59:40.000Z", text: "Prefer the existing migration.", status: "delivered", delivered_at: "2026-11-20T09:59:41.000Z", via: "opencode-service" },
    ],
  };
}
