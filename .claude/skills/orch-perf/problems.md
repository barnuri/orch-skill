# Problem map (orch session, one 200-node run plus the Bun port)

One row per problem. Status: FIXED (code or rule shipped), PARTIAL, OPEN. `P` ids are stable: use them
in commits, learnings blocks and tasks. Evidence is from run state, job logs, tests and git history.

## A. Latency and throughput

| ID | Problem | Evidence | Root cause | Status |
|---|---|---|---|---|
| P1 | Every CLI call takes seconds | `run status` 7.1 s wall, 0.4 s CPU, about 90 process starts | bash plus jq, process start 80 ms or more under scanning and load | FIXED: measured 0.356 s run status (was 7.1 s) |
| P2 | Node cold start | opencode start 6 to 10 s, plus pane and launcher | one process and one pane per node | OPEN (warm agent pool in backlog A3) |
| P3 | High machine load | load average 20 to 35 with endpoint security, Finder, other agents | many concurrent agents and process starts | OPEN (load-aware scheduler A7) |
| P4 | Full test suites in nodes | 8 to 12 min per run, four runs in one node | no fast tier, agents ran everything | PARTIAL: fast tier, budget and resume built; in-process runner in progress |
| P5 | Slow test files | files of 120 to 240 s (liveness, loops-watches, pause, wait) | a process per command, fixed sleeps | PARTIAL: speed work running |
| P6 | Parallel cap too low | cap 4 left ready nodes waiting | fixed per-run cap | FIXED: cap 15 default via profile defaults (watch the load) |

## B. Agent behaviour and supervision

| ID | Problem | Evidence | Root cause | Status |
|---|---|---|---|---|
| P7 | Agents end their turn early, node turns done with no handoff | 145 of 181 done nodes without handoff, 5 nodes lost 40 to 80 min | text-only reply ends `opencode run`; no live supervisor | PARTIAL: watchdog flags it and re-queues once; resume with a continue message still open |
| P8 | Weak models ask the user in text and end | nodes ended with "Reply D1 or D2" | no tool-only discipline, weak brief | PARTIAL: rule 10, `node ask`; brief generator open |
| P9 | Wrong prompt after retry | a retried node asked "what task?" | retry lost the goal or progress | FIXED: da06bc6 (test only; it already worked) |
| P10 | Nodes guess when blocked | decisions taken without an answer | late or no answers | PARTIAL |
| P11 | Smart-auto cost concentration | 96 percent of cost on 169 nodes | unpinned routing | PARTIAL: pinned profiles (opus plan, haiku exec, sonnet verify) |

## C. Coordination and messages

| ID | Problem | Evidence | Root cause | Status |
|---|---|---|---|---|
| P12 | Slow answers | median ask latency 702 s | coordinator answers when it notices | PARTIAL: herdr bridge into the coordinator pane; auto-answer open |
| P13 | Shell timeout kills `ask --wait 600` | agents wait 120 s max, turn ends, job "killed" | wait longer than the tool timeout | FIXED: wait 90 s, rule |
| P14 | Asks lost when the coordinator pane changed | coordinator pane id changed after a crash | pane id stored, not the session | FIXED in code (session id, repoint, redelivery), unrun |
| P15 | Answers to ended nodes never read | same question asked three times | no prepend to retry | PARTIAL: guard coded, unrun |
| P16 | Typing into the user's pane | risk when the user types | bridge types text | PARTIAL: not-while-typing rules coded, unrun |

## D. State, supervision and false alarms

| ID | Problem | Evidence | Root cause | Status |
|---|---|---|---|---|
| P17 | False "stuck starting", "stalled", "lost" | healthy nodes marked error | liveness from owner events only; pid-owned jobs silent | FIXED: job folder (pid, log growth) wins |
| P18 | Stale watchdog flags kept the pill red | flags stayed after the cause was gone | no flag clearing | FIXED (self-clearing flags, colours) |
| P19 | Red used for non-errors | pill red for "unverified" | colour rule missing | FIXED: red only for error or fail, test scans CSS |
| P20 | Duplicate workers on one node | about 12 jobs in minutes | manual dispatch, engine, retries together | PARTIAL: one live job per node guard coded |
| P21 | Engine claim blocked a manual reset | node stayed waiting twice | claim per attempt not released on reset | FIXED: da06bc6 |
| P22 | Wrong node timing | durations counted from trigger, queue time as run time | single `started` stamp | PARTIAL: dispatched, started, finished stamps and `starting` state coded |
| P23 | Missing data on cards | actual model, role, tier, effort, cost showed dashes | owner not bound for herdr jobs; hub worker id missing; effort never copied | PARTIAL: fill and bind coded; 173 old nodes unfilled |
| P24 | Cost counted twice for one session | run total 6.00 vs 3.00 | two nodes bound to one session | FIXED: first node gets the cost |
| P25 | A status read wrote state | `run status` applied owner binding | side effects in a read | FIXED in the port (read only), writes in the watchdog |

## E. Repo, merge and build hygiene

| ID | Problem | Evidence | Root cause | Status |
|---|---|---|---|---|
| P26 | Shared working tree | one unfinished edit broke every call (missing lib in a list) | all nodes edit one checkout | PARTIAL: worktrees used for subagents; not for nodes |
| P27 | Half-merged tree from duplicates | 44 changed files, duplicated list entries | P20 plus P26 | FIXED by hand |
| P28 | Merge conflicts at every port merge | `cli.ts`, `dispatch.sh`, lists | many branches edit the same registries | PARTIAL: resolved each time; registry design open |
| P29 | `node_modules` self symlink committed | install broke, bundle failed | symlink created in the repo root, then committed | FIXED: removed, ignored, `bun install` |
| P30 | Server type imported into the web bundle | bundle failed on `node:fs` | type lived in a server file | FIXED: shared types |
| P31 | Strict type errors after the port | 69 errors, noUncheckedIndexedAccess | ported without typecheck | FIXED |
| P32 | `git index.lock` collisions | commit failed while subagents committed | many writers on one repo | OPEN (benign, retry) |
| P33 | Personal data in committed learnings | run ids, costs, paths | learnings file was tracked | FIXED: ignored; still in history |

## F. Test suite after the port

| ID | Problem | Evidence | Root cause | Status |
|---|---|---|---|---|
| P34 | Tests spawn `bash dispatch.sh` | 58 failing cases first run | rename to `dispatch.ts` missed in tests | PARTIAL: replaced; more failures remain |
| P35 | Guessed command names | `run sweep-coordinator` | tests written without the CLI table | OPEN (fixer running) |
| P36 | Dropped tests of bash internals | lib-level tests removed | libs no longer exist | OPEN: coverage gap, CLI-level replacements only |
| P37 | Parity checks lost their oracle | bash path deleted | port finished | OPEN: determinism checks only |
| P38 | 9 failing bun tests in src | reaper, health routes, detachedSpawn, plugin | renames and process spawns | OPEN (fixer running) |
| P39 | Code unverified at merge time | user rule: tests once at the end | speed over safety | PARTIAL: first full run done, fixes running |

## G. Product and UI gaps found along the way

| ID | Problem | Evidence | Root cause | Status |
|---|---|---|---|---|
| P40 | Herdr panels piled in one tab | six panels in one tab | split instead of tab per node | FIXED in code (tab per node, linger, sweep), unrun |
| P41 | Dead panels never cleaned | eight dead panes | no sweep | FIXED in code; cleaned once by hand |
| P42 | Graph pane reopened after the user closed it | pane came back | host reopened on every open | FIXED: `--once` in the host |
| P43 | Agent output without colour | pipes drop colour | no pty | FIXED in code (pty, ANSI log, plain log) |
| P44 | Run page toggles not remembered | follow, zoom, mode reset | per-run state | FIXED: global localStorage |
| P45 | Cron text missing in schedules | raw expression only | no translator | FIXED |
| P46 | Notifications missed | finished node unseen until the next prompt | no background watch | PARTIAL: follow watch, bridge |
| P47 | Fake CLI binaries still shell | four `.sh` fakes in test support | not ported | OPEN |
| P48 | Stale `lib/*.sh` mentions | about 76 in docs and comments | rename sweep | OPEN |

## Counts

48 problems: 21 FIXED, 20 PARTIAL, 7 OPEN (P2, P3, P9, P21, P32, P36 to P38 overlap with PARTIAL rows; the table is the source of truth).
Next review: run `bun scripts/orch-perf.ts` and update the status column; add a new `P` row per new problem.
