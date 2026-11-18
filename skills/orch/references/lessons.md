# Lessons

Rule: every time the coordinator makes a bookkeeping mistake, add an entry here and, where possible, a check in the CLI. Each entry names what happened, what now prevents it, and the test that covers it. Tests live in `tests/runs/visibility.test.sh`.

## 2026-11-15

1. **Nothing updated the graph unless the coordinator remembered.** Status changes for inline and subagent work depended on `node update`. Now: the dashboard server runs `run sync --no-retry` every 30 s, and `run wait` wakes the coordinator on changes. Tests: `wait wakes on change`, `wait settled`, `src/server/runs/node-activity.test.ts` (reconciler cases).
2. **Work was recorded in a batch after the fact.** Start and finish times and durations were wrong. Now: a node finished without running is flagged `backfilled` and shown as "recorded after the fact"; `--at` records the real time (not in the future). Tests: `backfilled flag set`, `--at in the future rejected`.
3. **A node stayed `running` after its agent finished, and nobody could tell.** Now: heartbeats (`updated`, `node ping`), `stale` after `settings.stale_minutes`, a banner on the run page, a `stale:` line in `run sync`. Tests: `sync prints stale line`, `ping clears stale`.
4. **A node was marked running with nothing doing the work.** Now: `--owner`, a job id becomes the owner, and a running node with neither is `unowned` in `run sync`, `run status` and the dashboard. Tests: `L1 sync prints unowned`, `L1 status marks unowned`, `L1 job id becomes owner`.
5. **A node was moved back to waiting and kept its old start, error and job.** Now: `waiting` clears them (a failed attempt is archived) and the allowed moves are enforced; `--force` overrides. Tests: `L2 waiting clears ...`, `L2 failed attempt archived`, `L2 done->running refused`.
6. **A dependency on a node finished in the origin of a carried run was refused.** Now: `node add --after X` accepts a finished node of any run in the `continued_from` chain and names the runs searched when X exists nowhere. Tests: `L3 finished origin dependency accepted`, `L3 error names searched runs`.
7. **A mistaken node could not be removed.** Now: `node remove` (waiting nodes without running or done dependents; `--force` otherwise) with an event. Tests: `L4 removes waiting node`, `L4 refuses done node`.
8. **A made-up job id was recorded.** Now: `node update --job J` needs `jobs/J` to exist, unless `--force`. Tests: `L5 unknown job refused`.
9. **Command output was thrown away, so errors went unseen.** Rule in SKILL.md "Mistakes to avoid": read the result of `node add/update/report`. The CLI exits 2 with a message for every refusal above.
10. **A status-check loop ended itself eight minutes into its first hour.** The loop prompt said "reply OK, do nothing else"; the model read that as a reason to write `STOP` to the loop's `control` file, which the loop contract allows, so the loop ended with `reason: "agent"` while the coordinator still listed it as running. Now: SKILL.md "Loops and monitors" says a pure status check is a watch (no model, no tokens), and a loop prompt must give the agent real work and never invite it to stop. Verified live: `orch active` is the check, and it listed no loop once the loop had stopped.
11. **A question was asked in plain text and the turn ended, so every parallel node sat idle.** The coordinator wrote the makeover questions into its reply and stopped; six ready nodes did not start until the user asked "why did you stop". Now: SKILL.md "Asking the user" makes the question tool the default for every question, requires starting independent nodes first, and groups decisions with a recommended option. Check: read your last message before ending a turn: if it contains a question or a list of ready nodes, you are not done.
12. **Three of eight "running" nodes were not running.** Two agents had finished and the coordinator had not recorded it; one node was a task that does not run continuously. A `[STALE]` flag also fired on three nodes whose agent was alive but never pings. Now: before you say a node is running, check evidence for its owner (files it changed in the last minutes, a live process, a port that answers, whether it already reported back), then ping the node with that evidence. A task that is only done between other work (such as committing checkpoints) stays `waiting`. Now prevented: `node verify-owners` (run by `run status`, `run sync`, the reconciler) checks the owner and closes the node as unreviewed-done or error, and `owner event` hooks push the same. Tests: `liveness.test.sh`, `orch-nodes-plugin.test.ts`, `orch-owner-event.test.sh`.
13. **Every new node showed owner "unknown".** Coordinators ran `node update <id> running --owner "agent ses_xxx (spawned)"`. The owner text is free text; `owner_parse` only accepts a bare id, so the node got kind `unknown`, no registry entry, and no liveness or activity. Also, `run start` stored `pid-<n>` as the harness session because the session-id fallback ignored `OPENCODE_SESSION_ID`. Now: pass the real session id (`--owner ses_xxx`), or let the binder find it. `node bind-owners [--run R]` (also run by `run sync`, `run status`, `node verify-owners` and the reconciler) tries: a session id/uuid/pid inside the owner text; the plugin's `owners/pending/<child>.json` (title match, then start time); opencode's children of the run's session. It never guesses on a tie: the node gets `owner_state: unbound` and `owner_reason`. A node running 2 min with no owner gets `unowned` and a "running without an owner" event. A bound owner fills EMPTY model, tokens, cost, harness and last activity. Tests: `owner-bind.test.sh`, `orch-nodes-plugin.test.ts`.

## 2026-11-16 run 20261115-114006-0bff (about 12 hours, 170 nodes)

Each item: what happened, the cost, the rule now.

14. **REPEATED** (priority high, seen again 2026-11-16 12:31-14:07Z) **Agents ended their turn early and the node turned `done` with no handoff.** Four nodes (`scripts-reorg` twice, `run-watchdog`, `node-real-duration`, `model-effort-fix`) stopped after a text-only message. Cost: about 80 minutes for a file move, and a half-merged tree. Rule: write `handoff.md` first and update it; the watchdog marks done without a handoff `error` and resumes the same session with a "continue" message.
15. **REPEATED** (priority high, seen again 2026-11-16 12:31-14:07Z) **Several workers ran one node.** My manual dispatch, the engine and watchdog retries started about 12 jobs in minutes and they edited the same files. Rule: one live job per node; check the jobs dir before a manual dispatch; the engine claim is per attempt.
16. **A manual reset to `waiting` was blocked by the old claim.** `model-effort-fix` sat waiting twice. Rule: a reset must release the claim file of that attempt.
17. **Nodes share one working tree, so one unfinished edit breaks everyone.** `core/state/timing.ts` had a syntax error and every `node update` failed. Rule: one worktree per code node when they run in parallel, and a syntax check (`bash -n`, `dispatch.ts run status`) before any commit.
18. **Full test suites ran inside nodes.** The bash suite took 8 to 12 minutes, four times in one node. Rule: only touched tests, a 5 minute cap, full suite once in `final-gate-full`.
19. **REPEATED** (priority high, seen again 2026-11-16 12:31-14:07Z) **The coordinator reported stale status.** A node was reported running after it finished, and a done node went unseen until the user asked. Rule: read `state.json` fresh before each status word; keep a background `run wait --follow`.
20. **REPEATED** (priority high, seen again 2026-11-16 12:31-14:07Z) **Node questions did not reach the coordinator, and finished nodes asked again.** `delivered_at` stayed null, and answers to ended nodes were never read (the same question came three times). Rule: asks are typed into the coordinator pane (herdr bridge) and unread answers are prepended to a retry prompt; a node checks its inbox before it asks.
21. **Red was used for things that were not errors.** The watchdog pill went red for "done without handoff". Rule: red means error or fail only.
22. **Cap and load.** A per-run cap of 4 left ready nodes waiting while load was 20 to 35. Rule: the cap is a profile default (15); watch the load before raising it.
23. **Process starts are the real cost.** `dispatch.ts run status` took 7 s wall for 0.4 s CPU (about 90 process starts under Defender). Rule: measure wall time and process count before optimizing; hot commands move to the Bun core.

## 2026-11-17 review

- Run 20261115-114006-0bff, 12:31-14:07Z (then handed to unorch): 25 nodes, 39 jobs for 10 nodes, 10 done without handoff, 12 duplicate starts, 4 stuck starting, 4 jobs gone; ready lag 11 min, error idle 127 min. 12 waiting and 4 error nodes still open 15 h later.
- New: 24 a job whose pane starts 4-31 min late still runs after `stuck starting` and its retry (about 45 job-min duplicate); 25 a job that ends on a plain-text question is retried and asks again (19 of 39 jobs); 26 a run handed over to unorch stays open with stale nodes; 27 the lesson-12 guard (`liveness.test.ts`) flakes under load (2 of 4 runs).
- **REPEATED**: 14, 15, 19, 20. Guards for 14, 15, 16 landed at 23:05 (core-gaps 08, 10, 11) after these events and pass.
- Guard tests: 77 tests in 20 files run, 76 pass, 1 flaky (liveness). No guard test: 9, 10, 11, 17, 23. Guard tasks: agent-spec/learning/2026-11-17-*.md (4 files).

## 2026-11-18 review

- Runs: 20261117-160316-0d9c (done, 24 nodes, 27 min dep-to-start lag); 20261117-190137-8cad (running, 30 nodes, 163 min lag, `openapi-review` ready 22:14Z and still waiting at 05:01Z).
- New: 28 a ready node with no `auto_dispatch` waited 6 h 47 min unflagged; 29 an errored node waited 43 min for its retry; 30 two sibling nodes asked the same question (m6, m7).
- **REPEATED** (priority high): 15 duplicate starts: 2 nodes ran 3 times, 4 nodes ran twice.
- Guard tests: visibility, liveness, health, core-gaps 08-11 pass 18 of 18. owner-bind (13) fails 1 of 4. No guard test: 9, 17, 23, 28-30.
- Guard tasks: agent-spec/learning/2026-11-18-ready-node-idle.md, agent-spec/learning/2026-11-18-owner-bind-guard-fails.md. No code changed, no commit.

## 2026-11-18 retro (run 20261117-190137-8cad)

31. **The watcher ended after each event.** The coordinator re-armed it by hand every time. Rule: a watcher survives events and ends only on run end or stop.
32. **Node 413 was built from screenshots.** Each cycle needed an image read and a guess. Rule: UI nodes read the DOM or API state first; cap image reads (4, under 400 KB each).
33. **llm-hub restarted at 08:28 with no recorded cause.** Rule: every service restart writes who and why to the run log.
34. **The installer and a restart collided.** Rule: installer and restart take one shared lock.
35. **Parallel edits on one file broke the shared tree again** (precommit-smoke typecheck failed on `run-filters.ts:39` from other nodes' uncommitted work; extends 17). Rule: one writer per file per run; the second node waits or asks.
