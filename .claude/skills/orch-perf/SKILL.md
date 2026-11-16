---
name: orch-perf
description: Repo skill for making orch faster than plain opencode subagents while keeping its value (visibility, a model per task, cost and token reduction, context reduction). Holds the measured weak spots, an improvement backlog with new architectures and refactors, the benchmark method, and a self-learning loop (scripts/orch-perf.ts appends numbers to learnings.md after each run and marks WORSE and REPEATED). Use when orch feels slow, before changing how nodes are started, and after a long run. Triggers: "orch is slow", "why did the run take hours", "make orch faster", "orch vs subagents", "orch-perf".
---

# orch-perf

Orch exists for visibility, the right model per task, lower cost and tokens, and smaller contexts. A run of 200 nodes took about 12 hours, while the same kind of work finished in minutes with opencode subagents in this session. This skill keeps what we know about that gap, and what to try.

## 0. Files in this folder

- `SKILL.md` (this file, committed): generic weak spots, backlog and method. No personal data.
- `analysis.md` (committed): the deep analysis of why orch was slow and gave worse results than opencode subagents, with the evidence and a build list. Read it before changing the architecture.
- `learnings.md` (ignored by git): the dated metric blocks that `scripts/orch-perf.ts` appends. They contain run ids, costs and paths, so they stay on this machine.
- `local.md` (ignored by git): paths of llm-hub, herdr, herdr-web and the other projects orch depends on, plus open upstream issues. Copy `local.example.md` to create it on a new machine. **Read it first.** When a problem comes from one of those projects, fix it in that project's own repo.

## 1. Self-learning loop (do this first)

1. After a run, and daily (schedule `orch-perf-daily`): `bun scripts/orch-perf.ts [run-id]`.
2. It appends one dated block to `learnings.md` in this folder: node counts, median node seconds, median queue seconds, early-ended nodes (done without handoff), error and retry counts, ask latency, cost by profile and the load average.
3. It marks a metric **WORSE** when it is worse than the previous block, and a problem **REPEATED** when it appeared before.
4. Read the new block. For each REPEATED or WORSE item, add a row to section 3 (backlog) with the cause, and fix the cause in code, not only in a note. Then re-run the script after the fix and check the number moved.
5. Add a lesson to `skills/orch/references/lessons.md` only when a rule or a guard exists for it.

## 2. Measured weak spots (run 20261115-114006-0bff, 2026-11-16)

| # | Weak spot | Evidence | Direction of fix |
|---|---|---|---|
| W1 | Every orch command costs about 90 process starts | `dispatch.ts run status` 7.1 s wall for 0.4 s CPU: 50 printf, 19 jq, 10 stat, 6 date; process start 80 ms or more under Defender and load | Bun core, one process per command, long-lived server for hot paths |
| W2 | Agents end their turn early | 145 of 181 done nodes had no handoff, 5 nodes lost 40 to 80 minutes redoing work | handoff first, resume the same session with a continue message, watchdog guard |
| W3 | The coordinator answers slowly | median ask latency 702 s, nodes waiting on a shell timeout of 120 s | herdr bridge into the coordinator pane, node ask wait 90 s, coordinator answers within one turn |
| W4 | Duplicate workers on one node | about 12 jobs in minutes after manual dispatch plus engine plus watchdog retry | claim per attempt, refuse a second live job, release the claim on reset |
| W5 | Shared working tree | one unfinished edit broke every node (`TIMING_JQ_DEFS`) | one git worktree per code node, merge after |
| W6 | Full test suites inside nodes | 8 to 12 minutes per run, four runs in one node | touched tests only, fast tier under 30 s, full once at the end |
| W7 | Machine load 20 to 35 | Defender, Finder and other agents; every extra node adds process starts | cap parallel nodes by load, not a fixed number |
| W8 | Cost concentrated in smart-auto | $77 of $80 on 169 smart-auto nodes, haiku nodes cost $2.56 for 29 nodes | pin a cheap model for mechanical tasks, a strong one only for plan and review |
| W9 | Weak models end turns and ask in text | haiku nodes asked the user in text and ended | `node ask` only, rules in the prompt header, resume on early end |

## 3. Improvement backlog (new things, new architectures, refactors)

Each item lists the expected gain. Mark the ones you ship and keep the measured number.

- **A1 One long-lived Bun core** (the dashboard server) owns state reads and writes. The CLI makes one local call. Gain: command latency from seconds to tens of milliseconds. Status: Bun port in progress (take-* branches).
- **A2 Hybrid dispatch: in-session subagents for small tasks, orch nodes for big ones.** A node under about 5 minutes of work does not need a herdr pane, an opencode cold start (6 to 10 s) and a handoff cycle. Route by estimated size: subagent inside the coordinator, or orch node with its own pane. Orch still records the task in the run for visibility and cost.
- **A3 Warm agent pool.** Keep 3 to 4 opencode servers running (`opencode serve`) and attach a node as a session, instead of a cold process per node. Gain: seconds per node, shared model connections.
- **A4 Event-driven everything.** No polling, no foreground waits: fs events on state, SSE to the UI, the watchdog reacts. Status: engine and watchdog built; remove the remaining `sleep` loops.
- **A5 Handoff as the unit of work.** A node is a contract: input files, acceptance checks, output file. The engine verifies the output file and the checks, then marks done. An agent that ends early is resumed, not retried from scratch.
- **A6 Context diet.** Give each node a generated brief (goal, files, acceptance, last handoff of its dependencies), not the whole conversation. Measure input tokens per node in learnings.
- **A7 Load-aware scheduler.** Cap parallelism from the real load average and process count, and prefer finishing started nodes over starting new ones.
- **A8 Cost router.** Pick the model per task kind from measured cost and success (haiku for mechanical edits and ports, opus for plans and reviews, sonnet for the final verify); record per-kind success so the router learns.
- **A9 Fewer, larger deterministic steps in the engine.** Tests, commits, restarts and merges run in the engine or watchdog as plain commands, never through an agent.
- **A10 Worktree per code node, auto-merge on green.** Removes the shared-tree breakage and lets many nodes edit in parallel.

## 4. Benchmark method (orch vs subagents)

1. Pick 6 real tasks of mixed size (2 small, 2 medium, 2 large) from a finished run.
2. Run each twice: as an orch node (same profile) and as an opencode subagent in a worktree. Same model, same prompt, same machine load window.
3. Record wall time, queue time before first activity, tokens in and out, cost, number of coordinator interactions, and result quality (acceptance check passes).
4. Put the table in `learnings.md`. The decision rule: orch is worth it when its overhead per node is under 20 percent of the node time, or when the task needs visibility, a pinned model, a cost cap or context isolation.

## 5. Rules for changes made through this skill

- Measure before and after with `scripts/orch-perf.ts` and `bun scripts/verify/check-run-page.ts`; a change counts only when a number in `learnings.md` improves.
- All new code is TypeScript for Bun (see CLAUDE.md). No bash.
- Keep the user rules: one test run at the end, commit by path, no push.
