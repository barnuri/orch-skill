import "./how.css";
import type { CSSProperties } from "react";
import { Chip } from "../components/Chip";
import { PageHead } from "../components/PageHead";

interface Lane {
  label: string;
  who: string;
}

/** Swim lanes, top to bottom. `row` in a step is the 1-based index here. */
const LANES: readonly Lane[] = [
  { label: "User", who: "chat or CLI" },
  { label: "Orchestrator", who: "the agent in the session" },
  { label: "State", who: "dispatch.ts writes only" },
  { label: "Supervisor", who: "one watchdog in the server" },
  { label: "Harness jobs", who: "one job or session per node" },
  { label: "Gate and delivery", who: "done gate, then the PR" },
];

interface Step {
  code: string;
  col: number;
  row: number;
  title: string;
  body: string;
  cmd: string;
}

/** The happy path. `col` is the time step, `row` the lane. Steps are listed in flow order. */
const STEPS: readonly Step[] = [
  { code: "S1", col: 1, row: 1, title: "User request", body: "Each ask becomes one requirement with its own id.", cmd: "req add <run> \"<ask>\"" },
  { code: "S2", col: 2, row: 2, title: "Orchestrator plans", body: "Picks a profile per node and sets the dependencies.", cmd: "node add <run> <node> --after" },
  { code: "S3", col: 3, row: 3, title: "Run and graph", body: "state.json holds the graph. requirements.json holds the asks.", cmd: "run start" },
  { code: "S4", col: 4, row: 4, title: "Supervisor dispatches", body: "Starts every ready node, up to settings.max_parallel at once.", cmd: "run watch" },
  { code: "S5", col: 5, row: 5, title: "Node runs", body: "Pings progress and reports model and tokens while it works.", cmd: "node ping · node report" },
  { code: "S6", col: 6, row: 5, title: "Handoff and result", body: "Writes handoff.md to ORCH_NODE_OUT, then a verdict.", cmd: "node result --verdict" },
  { code: "S7", col: 6, row: 6, title: "Done gate", body: "Fails on open asks, partial nodes or missing delivery evidence.", cmd: "run verify" },
  { code: "S8", col: 7, row: 6, title: "Delivery", body: "Commit, push and PR. The PR URL and checks go on the ask.", cmd: "req evidence <run> <id>" },
];

interface Recovery {
  code: string;
  title: string;
  flag: { status: string; label: string };
  steps: readonly { label: string; text: string }[];
}

/** Recovery paths. Each one reads Detect, Act, End. The chip is the flag the dashboard shows. */
const RECOVERY: readonly Recovery[] = [
  {
    code: "R1",
    title: "Stalled or dead node",
    flag: { status: "stale", label: "stalled" },
    steps: [
      { label: "Detect", text: "Running and idle past stall_minutes (15), or job pid gone and log silent for 2 min." },
      { label: "Act", text: "Stalled: amber flag, reported once. Dead: node set to error \"process died\", one retry." },
      { label: "End", text: "The retry resumes. A second death flags lost (error) for you." },
    ],
  },
  {
    code: "R2",
    title: "Missing handoff",
    flag: { status: "stale", label: "unverified" },
    steps: [
      { label: "Detect", text: "Node turns done, but handoff.md is missing or empty." },
      { label: "Act", text: "Node is unverified. node retry --early-end resumes the same session to write handoff.md." },
      { label: "End", text: "After 2 resumes: error \"ended early without handoff\"." },
    ],
  },
  {
    code: "R3",
    title: "CLI or source error",
    flag: { status: "error", label: "cli-source" },
    steps: [
      { label: "Detect", text: "Node turns error with a CLI or source runtime error." },
      { label: "Act", text: "Flag cli-source, node tell to the orchestrator. Never retried." },
      { label: "End", text: "Fix the cause, then node retry. Infra errors such as model unavailable get one retry instead." },
    ],
  },
  {
    code: "R4",
    title: "Owner unknown",
    flag: { status: "stale", label: "unowned" },
    steps: [
      { label: "Detect", text: "Running with no owner and no job for 2 min: unowned. Owner not bound: unbound, with the reason." },
      { label: "Act", text: "run sync and the watchdog run node bind-owners. The flag stays until a session or job binds." },
      { label: "End", text: "Bound: the owner shows on the node. Still unbound: pass --owner, or retry the node." },
    ],
  },
  {
    code: "R5",
    title: "Feedback",
    flag: { status: "waiting", label: "feedback" },
    steps: [
      { label: "Detect", text: "A user note about orch: feedback add with --kind and --source." },
      { label: "Act", text: "feedback work queues one feedback-batch run: a node per item, then a validate node." },
      { label: "End", text: "Each item closes as done or wontfix, with a result." },
    ],
  },
];

const LEGEND: readonly { status: string; meaning: string }[] = [
  { status: "waiting", meaning: "queued, not started" },
  { status: "running", meaning: "work in progress" },
  { status: "done", meaning: "finished, handoff present" },
  { status: "stale", meaning: "needs a look, not failed" },
  { status: "error", meaning: "failed, retry or fix" },
  { status: "skipped", meaning: "not run" },
];

export function HowPage() {
  return (
    <div className="how-page">
      <PageHead title="How orch works" subtitle="A user request becomes a run, a graph of nodes and a delivered PR. The supervisor moves ready nodes and recovers failures." />

      <section className="how-section" aria-labelledby="how-flow-title">
        <div className="how-section-head">
          <h2 id="how-flow-title">Main flow</h2>
          <ul className="how-legend" aria-label="Status legend">
            {LEGEND.map((item) => (
              <li key={item.status} title={item.meaning}>
                <Chip status={item.status} />
                <span>{item.meaning}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="how-lanes">
          {LANES.map((lane, i) => (
            <div key={lane.label} className="how-band" style={{ "--r": i + 1 } as CSSProperties} aria-hidden="true" />
          ))}
          {LANES.map((lane, i) => (
            <div key={`label-${lane.label}`} className="how-lane-label" style={{ "--r": i + 1 } as CSSProperties}>
              <span className="how-lane-name">{lane.label}</span>
              <span className="how-lane-who">{lane.who}</span>
            </div>
          ))}
          {STEPS.map((step, i) => (
            <article
              key={step.code}
              className={`how-step${i === STEPS.length - 1 ? " is-last" : ""}`}
              style={{ "--c": step.col, "--r": step.row } as CSSProperties}
            >
              <div className="how-step-head">
                <span className="how-code">{step.code}</span>
                <span className="how-lane-tag">{LANES[step.row - 1]?.label}</span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
              <code className="how-cmd">{step.cmd}</code>
            </article>
          ))}
        </div>
        <p className="how-note">
          A failed gate, a partial node or an open ask sends the run back to S2: the orchestrator adds or retries nodes. Ready nodes repeat S4 to S6 until no node is ready.
        </p>
      </section>

      <section className="how-section" aria-labelledby="how-recovery-title">
        <div className="how-section-head">
          <h2 id="how-recovery-title">Recovery flows</h2>
        </div>
        <ol className="how-recovery" role="list">
          {RECOVERY.map((flow) => (
            <li key={flow.code} className="how-flow">
              <div className="how-flow-head">
                <span className="how-code">{flow.code}</span>
                <h3>{flow.title}</h3>
                <Chip status={flow.flag.status}>{flow.flag.label}</Chip>
              </div>
              <ol className="how-chain" role="list">
                {flow.steps.map((s) => (
                  <li key={s.label} className={`how-link how-${s.label.toLowerCase()}`}>
                    <span className="how-link-label">{s.label}</span>
                    <span className="how-link-text">{s.text}</span>
                  </li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
