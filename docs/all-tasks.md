# All tasks of the session, with status

Status: DONE (merged and a test or check passed earlier), CODED (merged, never run: see docs/to-verify.md),
RUNNING (a subagent works on it), OPEN (not started or blocked). Source of truth for checks:
`.claude/skills/orch-perf/checklist.md`; for problems: `problems.md`.

## A. Handoff extra tasks 1 to 22
| # | Task | Status |
|---|---|---|
| 1 | Run page: last 5 activities, readable node output | CODED (f221488) |
| 2 | Run page: actual model, tier, role, effort | CODED (fill and cards; 173 old nodes empty) |
| 3 | opencode best flags (skills, MCP, config, super agent, no standalone) | CODED (profile env without disabling vars; start time 7.2 to 6.1 s) |
| 4 | herdr parallel work, agents talk to each other | CODED (messaging, bridge, SKILL.md section) |
| 5 | Pause and resume in the run page, one-click Resume | CODED |
| 6 | Status-change toasts, prominent errors | CODED |
| 7 | Long-running indicator, per-node cancel and restart | CODED |
| 8 | Run summary counts | CODED |
| 9 | Run filter and search | CODED |
| 10 | Live updates, no refresh | CODED |
| 11 | Main session delegates: plan strong, implement cheap, review strong | CODED as a skill section (`delegate`), no live proof |
| 12 | Status watch never misses a change | CODED (follow watch, done check) |
| 13 | Orch service recovers runs (pause on shutdown, resume at boot, stop never resumes) | CODED and unit tested earlier (pause 26/0, stop 77/0); live restart not exercised after the port |
| 14 | Status from a fresh `state.json` read | DONE as a rule; `run status --fresh` coded |
| 15 | Model family icons, role and tier only for smart-auto | CODED |
| 16 | Learn from runs, daily | DONE: schedules `orch-perf-daily` and `orch-learn-from-runs`, `orch-perf` skill |
| 17 | Reorganize `skills/orch/scripts` and tests | SUPERSEDED by the TypeScript port |
| 18 | Generic profiles template, overlay | CODED |
| 19 | Why the reorg took 78 min | DONE (analysis in orch-perf) |
| 20 | Early-ended agents, shared tree | PARTIAL (guards coded, resume-on-early-end open) |
| 21 | Herdr bridge | CODED |
| 22 | Learn from issues | DONE (lessons.md items 14 to 23, problems P1 to P48, checklist) |

## B. Other user requests of the session
| Request | Status |
|---|---|
| Pause now, auto-resume after restart, stop never resumes | CODED, unit tested earlier |
| Commit all on master, no push, clean side branches | DONE (only master and cp2 worktree) |
| Fix cost double count | DONE (85b8e0f) |
| Colour rule: red only for errors | CODED (CSS scan test) |
| Global profile defaults, max_parallel 15 | CODED |
| Graph pane stays closed after manual close | CODED (herdr-mods `--once`) |
| Colour in node output, launcher in TypeScript | CODED |
| One herdr tab per node, 5 min close, dead panel sweep | CODED |
| Cron text in schedules | CODED |
| Global run page prefs (follow, zoom, mode, node tab) | CODED |
| Coordinator failover, node asks never lost | CODED |
| Nodes never use the question tool | DONE as rule 10 |
| `unorch` skill, `verify` repo skill, `orch-perf` repo skill | DONE |
| Move everything to TypeScript and Bun, no shell, no bash fallback | CODED: no `.sh` left; typecheck ok; tests failing, being fixed |
| Tests very fast, parallel, under 5 minutes | RUNNING (full tier 182 s at load 33; two fixers and 4 helpers working) |
| List of things to verify in a md file | DONE (docs/to-verify.md) |

## C. tasks.md (unorch) open boxes
| Node | Status |
|---|---|
| cr-final-review | OPEN: runs after the tests are green |
| final-gate-full | OPEN: one full run of all suites |
| bun-verify | OPEN: fresh-evidence verify of the Bun migration |
| bun-p6-retire | DONE (cutover merged, no `.sh` left); box to tick after bun-verify |
| session-retro | OPEN: write after the final gate |

## D. Running now
runs-group test fixer, other-groups test fixer, typecheck cache and parallel test-all, Bun port gaps (9 items), hot CLI speed, live herdr checks.
