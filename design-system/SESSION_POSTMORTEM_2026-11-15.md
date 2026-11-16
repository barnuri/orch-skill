# Session postmortem: 2026-11-15 orch coordinator session

Scope: the opencode coordinator session `ses_e24a528a1ffeO1NJ4FXpUhaG3k` ("Orch service with
schedulers", directory `orch-skill`, model `llm-hub/hub/smart-auto-balance`), its 63 child
sessions, and orch run `20261115-114006-0bff` (94 nodes, continued from `20261115-111421-4663`).

- The window is 11:00Z to 18:09Z = **7.15 h** (measured). Times are UTC; local time (IST) is +2 h.
  The session itself started on 2026-11-14 18:38Z. Earlier work is out of scope.
- Sources: a read-only copy of `opencode.db` (tables `session_v2`, `session_message`), plus
  `state.json` and `events.jsonl` of the run, plus `opencode.log`.
- Tool durations come from each tool part's `time.ran` → `time.completed`. Model time is the
  assistant message's `created` → `completed`, minus the union of its tool intervals.
- **M** = measured. **E** = estimated (the method is given).

## 1. Timeline (coordinator)

| UTC | What happened |
|---|---|
| 11:04-11:46 | User asks for chats UI, refresh button, run visibility, "parallel, release main session". 4 children spawned 11:24-11:26 (tests, runs UI, chat backend, React shell). The run is carried to `20261115-114006-0bff` at 11:40. 23 user messages this hour. |
| 11:47-12:12 | Chat UI, visibility, then a batch of 6 children at 12:10-12:12 (makeover design, React 2a, review, status bridge, handoff verify). |
| **12:19-12:50** | **The coordinator calls a follow-up subagent in the foreground** ("Bridge hook follow-up", 1833 s). It is blocked for 30.5 min. Four children finish in that time; their results queue for 10-22 min. |
| **12:53-13:05** | The coordinator ends its turn on a prose question about the makeover direction (Q1-Q6). It is idle for 12.7 min until the user asks "whats left why you stop?". |
| **13:08-13:41** | It asks with the `question` tool, but the call blocks for **2015 s (33.6 min)**. 4 children launched at 13:07 finish at 13:12-13:24 and are not read until 13:41 (17-29 min late). |
| 13:44-14:21 | tmp-leak, swap, warnings, liveness children. User: "all the running nodes really running?" At 14:28, 8 nodes are put back to `waiting` (status correction). |
| 14:26 | Auto-compaction #1 (850k cached tokens read). |
| 14:37-15:12 | 5 small children at 14:38. **Foreground follow-up** "Fake run retry" takes 881 s. User at 14:55: "you work very slow improve it". |
| 15:25-16:32 | Makeover pages, restart safety, 5 children at 15:55. **Two foreground follow-ups** take 866 s and 682 s. |
| 16:45-17:16 | 5 read-only reviewers, 3 bug hunters (each under 2 min). |
| 17:27-18:09 | Palette, latest packages, two garbled dictation messages, auto-compaction #2 at 17:41 (291k input), speed lessons. |

## 2. Time budget

### Coordinator: 7.15 h wall clock (M)

| Bucket | Hours | Min | Evidence |
|---|---:|---:|---|
| Model generation (thinking + writing) | 1.16 | 69 | 405 assistant messages. p50 6.8 s, p90 21 s, max 134 s (seq 3330). M |
| Blocked on **foreground** subagent follow-ups | 1.20 | 72 | 4 calls: 1833 s, 881 s, 866 s, 682 s. M |
| Blocked in `question` tool (user deciding) | 0.60 | 36 | 5 calls. One took 2015 s (13:08). M |
| Orch bookkeeping shell (`dispatch.ts ...`) | 0.59 | 35.5 | 86 calls, p50 14 s, p90 72 s, max 149 s. 49 used `timeout 150`, total 18.5 min, one hit the limit. M |
| Tests run by the coordinator | 0.44 | 26.3 | 39 calls, p90 158 s, max 234 s. M |
| Typecheck run by the coordinator | 0.20 | 12.2 | 35 calls, p50 15 s. M |
| `service.sh` restart/install/status | 0.16 | 9.8 | 24 calls (22 restart/install). M |
| git, other shell, sleeps | 0.13 | 8 | git 2.6 min, sleep 1.3 min, other 4 min. M |
| **Busy subtotal** | **4.47** | 268 | 54 busy turns. M |
| Idle, ended by the user (user away or reading) | 1.43 | 86 | 32 gaps: max 19.4 min (16:48), 12.7 min (12:53, prose question), 9.4 min. M |
| Idle, ended by a child report (nothing else to do) | 1.25 | 75 | 22 gaps, p50 3.9 min, max 12.7 min. M |
| **Total** | **7.15** | 429 | M |

Model time is only 16 % of the wall clock. 49 % of the busy time went to waiting on something
inside a tool: a foreground subagent, the question tool, or a test.

### Children: 63 sessions, 18.5 agent-hours (M)

| Bucket | Agent-min | Notes |
|---|---:|---|
| Bash test suites (`*.test.sh`, `dispatch.test.sh`) | 226 | 171 calls, p90 219 s, max 1212 s |
| `bun test` | 209 | 194 calls, p50 18 s, p90 120 s, max 880 s |
| `sleep` / poll loops waiting for a background run | 125 | 138 calls, max 1470 s (test-speed waiting for a baseline) |
| Browser / screenshot checks | 85 | 259 calls |
| `dispatch.ts` calls (node update, report, ping) | 56 | 239 calls, p90 38 s |
| Typecheck | 30 | 79 calls, p50 19 s |
| Other shell (edits by python/sed, grep, cat) | 47 | 852 calls, p50 0.7 s |
| Model generation | 241 | 4.0 h |
| Total tool time | 776 | 12.9 h. Shell is 99.6 % of it |

46 child shell calls were full-suite runs (whole `dispatch.test.sh` or `bun test src`): **150
agent-min**. Tests and typecheck together: **465 agent-min = 42 % of all child time** (M).
The "Make test suites fast" child alone ran tests for 141 of its 175 min, and still ended "Not
done to the bar".

Number of children running at the same time (M, from session start/end): 0 for 12 min, 1 for
84 min, 2 for 107 min, 3 for 78 min, 4 for 50 min, 5 for 60 min, 6 or more for 12 min. Mean is
about 2.6 children. For 96 min (22 % of the window), one child or none was working.

Cost (M): coordinator $25.1 in the window (opencode `cost`), children $48.2. Tokens: the
coordinator read 158 M cached tokens. Its context per call was p50 **287k**, max **850k**
tokens.

### Orch run `20261115-114006-0bff` (M)

- 94 nodes: 86 done, 6 waiting, 2 running. 83 edges. 410 events: 381 written by the coordinator
  through the CLI, 29 by the owner binder.
- All 94 nodes use profile `opencode-smart-auto`. They have **no job id, no usage, no cost**. orch
  dispatched none of them. The coordinator recorded all of them for opencode subagents it spawned
  itself, so orch has no token or cost data for the run.
- Node duration (started → finished): p50 20 min, p90 47 min, sum 2652 node-min. Four umbrella
  nodes inflate the sum: `react-phase2` 282, `makeover` 282, `test-speed` 186, `makeover-apply`
  163.
- Queue wait (add → started): p50 0.1 min, p90 35 min, sum 972 node-min. Worst waits:
  `chat-real-streaming` 175 min. `duration-format`, `docs-carry` and `chat-resume-gaps` waited
  81 min each, held while the makeover question was open. `rest-of-vanilla` 57 min,
  `visibility-dark` and `summary-stale` 53 min.
- Bookkeeping nodes: 7 nodes took under 1 min (lessons, junk cleanup, inline checks), plus 4
  umbrella nodes that only grouped children. Status churn: 12 `running→running` rewrites, of
  which 10 came at 12:15:24-31 in one sweep, and 8 `running→waiting` corrections, 5 of them at
  14:28. 1 node was removed.
- Throughput: 86 nodes done in 6.5 h = 13 per hour. Per hour: 11 h 2, 12 h 14, 13 h 12,
  14 h 25, 15 h 14, 16 h 14, 17 h 6.
- No 2-minute-or-longer gap without a real node running, except 17:21-17:29 (7.3 min).

## 3. Top 10 time sinks (ranked by measured minutes)

| # | Sink | Min | Type | Evidence |
|---|---|---:|---|---|
| 1 | Tests and typecheck inside children. 46 of these runs were full-suite runs (150 min). The suites ran at the same time in up to 5 children while the load was 17-50. | **465 agent-min** | M | child shell categories. `ses_e210b00aaffd` 141 min of tests. `ses_e206a93f9ffe` 32 min. `ses_e20145d96ffd` 24 min |
| 2 | Child results read late because the coordinator was blocked in the foreground | **152** (12 reports more than 60 s late) | M | "Small fixes" ended 13:12, read 13:41 (29.5 min). "React 2b" 25.9 min. "React 2a" 22.3 min |
| 3 | Sleep and poll loops in children waiting for their own background test runs | **125 agent-min** | M | 138 calls. `ses_e210b00aaffd` `while pgrep ... sleep 10` 1470 s. `ses_e207ab71fffe` 901 s |
| 4 | User wait on a question: prose question, then a blocking `question` call. 3-4 queued nodes held 81 min. | **12.7 + 33.6 = 46** (plus 243 node-min held) | M | idle 12:53-13:05, `question` 13:08 2015 s |
| 5 | Coordinator blocked on foreground subagent follow-ups | **72** | M | seq 4244 (1833 s), and 881 s, 866 s, 682 s |
| 6 | Coordinator and children `dispatch.ts` bookkeeping. `run status` takes 10 s on the 142 kB `state.json` | **35.5 coordinator + 56 children = 91** | M | 86 + 239 calls |
| 7 | Coordinator model time at 287k-850k context per call | **69** (about 35 of it avoidable) | M / E | p50 context 287k. Gen time grows with context (top 8 calls 50-134 s, all at 130k-690k) |
| 8 | Coordinator running tests and typecheck itself, again after children had run them | **38.5** | M | 39 test + 35 typecheck calls |
| 9 | Browser and screenshot checks in children, including one respawn | **85 agent-min** | M | 259 calls. `ses_e1fbe2330ffe` skipped its browser check, so `ses_e1fbd2666ffe` (9.5 min) redid it |
| 10 | Redone or split work: the same goal took 2-6 nodes | **≈ 90 agent-min** | E (sum of the wall time of the redo sessions) | `react-gaps`→`react-gaps2`. `makeover-pages-b`→`-gaps` (18.9 min). `tmp-leak`→`tmp-recount`→`profiles-tmp-fix`. `status-colors`→`palette-blue` (user reversed the colours). `test-speed`→`test-bash-13`/`test-ts-flakes`/`ts-tail-and-leak`/`web-tests-combined`/`latest-and-fast`/"Speed up the test suites" (18:08) |

Also measured, but smaller:

- 22 coordinator service restarts and installs: 10.4 min. 6 more in children: 1.8 min.
- Low parallelism: for 96 min, one child or none was running.
- 2 auto-compactions, at 14:26 (850k) and 17:41 (292k input, $1.54).
- Provider latency is **not** a problem: time to first token was p50 2.8 s, p90 4.8 s, max 9.3 s.
  `opencode.log` has no provider retries or 429s for the window. Its errors are 60 "cli process
  failed" and 41 "Failed to drain Session" lines.

### User side (M)

- 80 user messages in the window. Time to answer: p50 1.8 min, p90 11.7 min, max 44 min
  (13:05 "whats left why you stop?").
- About 11 were status or "is it really running" questions: "why i dont see the current run",
  "graph up2date?", "can we parallel more", "whats left why you stop", "all the running nodes
  really running?", "whats that status?", "status really reported right?", "why stuck",
  "you work very slow", "you done all?", "whats now?". Each one means the visibility had failed.
- 2 messages were garbled dictation (2673 and 272 characters, 17:32 and 17:45). 1 message was
  sent twice with a typo fix (11:28).
- Bursts: 8 messages at 15:10:29 and 4 at 11:23-11:26. Each burst started a long busy turn.

## 4. Changes, ranked by minutes saved

The savings are estimates (E), measured against this session's numbers.

### Process (how the coordinator should work)

1. **Never call a subagent in the foreground from the coordinator.** Follow-ups always run in
   the background. This saves 72 coordinator minutes, and most of the 152 min of late reports.
   **≈ 150 min of wall-clock delay.**
2. **Ask with the `question` tool at the moment of the decision, with a recommended default,
   while every node that does not depend on the answer keeps running.** Never end a turn on a
   prose question. Run independent waiting nodes (`duration-format`, `docs-carry`, ...)
   straight away. This saves 12.7 min of idle and about 33 min of blocked time, and unblocks
   243 held node-min. **≈ 45 min.**
3. **The coordinator does not run tests, typecheck or browser checks.** It reads the child's
   report and runs one final gate. **≈ 38 min.**
4. **Keep 4-5 children running all the time.** Queue the next nodes ahead, so a finished child
   is replaced in the same turn. 96 min ran at concurrency 1 or less. **≈ 30-40 min.**
5. **Rotate the coordinator context at about 200k.** Write a handoff and start a fresh
   coordinator, or compact earlier. Ask children for reports of at most 10 lines. **≈ 35 min**
   of model time, and about $10.
6. **Batch user requests into nodes once per turn**, and answer status questions from the
   dashboard link instead of re-deriving the state. **≈ 15 min.**

### Children and test discipline

7. **Children run only the tests for the files they touched.** No full suite, and never twice.
   Only the final gate runs the full suites, once. 150 agent-min went to 46 full-suite runs.
   **≈ 120 agent-min.**
8. **No sleep/poll loops.** Run long tests in the foreground with a timeout, or in the
   background with a completion notice. **≈ 100 agent-min.**
9. **Serialise heavy suites with a machine-wide lock**, for example an orch "test slot" with a
   semaphore of 2. Five agents running `bun test --parallel=6` at load 17-50 made every run 3-5
   times slower (see `findings-2026-11-15.md` S1). **≈ 100 agent-min.**
10. **State the acceptance in the prompt** ("browser check required: 1440 and 390, light and
    dark, attach the screenshot paths"). This prevents respawns like the palette verifier.
    **≈ 20-30 agent-min.**

### orch skill

11. **One batched bookkeeping call per turn** (for example `node update --batch file.jsonl`).
    Make `run status` a single `jq` pass instead of about 45. Let owner events from the opencode
    plugin flip `running` and `done`, so the coordinator writes no status. **≈ 30
    coordinator-min and 40 child-min.**
12. **Have orch dispatch the nodes itself** (adapter jobs) instead of the coordinator spawning
    subagents and recording them by hand. Orch would then own `usage`, `cost` and liveness. In
    this run every node has `usage: {}` and no job id, so the run gives no cost data, and the
    "really running?" questions were the result. **Quality gain, plus ≈ 15 min of status Q&A.**
13. **Auto-start a waiting node when its dependencies are done** and a concurrency slot is free,
    instead of waiting for the coordinator's next turn (queue wait p90 35 min). **≈ 30 node-min.**
14. **Mark umbrella nodes as groups**, so they do not count as running for 4.7 h, and drop
    "lesson" nodes into memory instead of the graph (7 nodes under 1 min).

### opencode config

15. Keep Code Mode on. Provider latency is fine (TTFT p90 4.8 s), so do not switch models for
    speed.
16. Set a lower auto-compaction threshold for the coordinator agent. A dedicated coordinator
    agent with a smaller tool set and no MCP catalog would help (see item 5).
17. Restart the service only once per batch of `src/` changes, not after every child. 28
    restarts took 12 min. **≈ 8 min.**

### Totals

- **Coordinator wall clock (E):** items 1-6 and 11 save about 3.0-3.5 h of the 7.15 h. Most of
  it is idle and blocked time, which a non-blocking coordinator would overlap with work.
- **Child agent-time (E):** items 7-10 save about 5.5 h of the 18.5 h.
