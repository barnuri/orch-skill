# Session retro (orch run 20261115-114006-0bff and the Bun port)

## What worked
- Subagents in git worktrees, one branch per lib group, merged by the coordinator: about 11,400 lines of bash ported to TypeScript in about 1 hour, versus hours for the same family of tasks as orch nodes.
- Precise prompts (files, rules, decisions already made) removed most questions.
- Measured numbers before opinions: `run status` 7.1 s to 0.356 s, `node update` 0.215 s.
- A single source of truth in md files (`tasks.md`, `to-verify.md`, `all-tasks.md`, `problems.md`, `checklist.md` with checks).

## What did not
- Orch nodes ended early, asked in text, were marked stuck while working, and ran as duplicates (see `.claude/skills/orch-perf/analysis.md`, P7, P17, P20).
- Tests ran last, so the first full run of the ported tree had 58 failing orch cases and 9 failing bun tests.
- Shared tree and many writers: `index.lock`, conflicts in `cli.ts` and the lists at every merge.
- Machine load 15 to 35 inflated every wait.

## Unsolved at the end
1. Full test run not yet clean and not yet under 5 minutes (last measured 182 s, 15 files failing; fixers running).
2. Live behaviour of coordinator failover by session id, tab reuse on retry, `service.ts install/restart/uninstall`, pill colours, `/api/cli`: see `docs/to-verify.md`.
3. Parity oracle gone after the port: only determinism and CLI-behaviour tests remain; tests of bash internals were dropped.
4. Early-end resume (P7), brief generator, warm agent pool, hybrid routing, load-aware scheduler (backlog in orch-perf SKILL.md).
5. Chat folders: no run against real harnesses, no `chat_roots` UI, `PUT /api/projects/{id}` lacks the roots check.
6. `cr-final-review` and `bun-verify` (independent review of the whole change set) were not run.

## How to speed up the feature lifecycle in this repo
- Write the checks first: each fixed problem gets a `check:` line in `checklist.md` and `--recheck` runs in the daily schedule.
- Fast tier before every commit (`run.ts`, under 30 s), `--changed` in the daily path, full tier once before a merge.
- One worktree per task, merge on green, small registries (`cli.ts` command table) split per command group to avoid conflicts.
- Use subagents for tasks that fit one prompt and finish in under 30 minutes; use orch nodes only for long unattended work (decision rule in orch-perf SKILL.md section 7).
- Keep the machine quiet while measuring (security scanning and other agents doubled every number).
