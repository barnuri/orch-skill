# Fix checklist (is it fixed, when, and did it come back)

Legend: `[x]` fixed, `[ ]` open or partial, `[!]` REGRESSED (a check failed after it was fixed).
Format: `- [state] P<id> <title> | fixed: <date> <commit> | check: <command that must exit 0>`.
`bun scripts/orch-perf.ts --recheck` runs every `check:` (120 s cap each, in parallel), flips a failing
`[x]` to `[!]` with the date, flips a passing `[!]` back to `[x]`, and prints the table. Run it after every
merge and in the daily schedule. A row without `check:` is not protected: add a check when you fix it.

- [x] P13 node ask wait stays under the shell timeout | fixed: 2026-11-16 338fd26 05d4fec | check: grep -q "wait 90" skills/orch/references/agent-rules.md
- [x] P17 job folder wins over owner events (no false stuck or stalled) | fixed: 2026-11-16 e93ef0a | check: ORCH_HERDR=0 bun test src/server/watchdog
- [x] P18 watchdog flags clear themselves | fixed: 2026-11-16 8c79174 | check: ORCH_HERDR=0 bun test src/server/watchdog src/web/shell
- [x] P19 red only for errors | fixed: 2026-11-16 8c79174 | check: bun test src/web/colour-red.test.ts
- [x] P24 one session cost is counted once | fixed: 2026-11-16 85b8e0f | check: bun skills/orch/tests/run.ts owner
- [x] P29 node_modules is not tracked and not a self symlink | fixed: 2026-11-16 08e6788 | check: test ! -L node_modules
- [x] P30 web bundle has no node imports | fixed: 2026-11-16 392844f | check: bun scripts/typecheck.ts
- [x] P31 strict typecheck is clean | fixed: 2026-11-16 0d20d1e dc5ae5f | check: bun scripts/typecheck.ts
- [x] P33 personal learnings are ignored | fixed: 2026-11-16 30a7aa3 | check: git check-ignore -q .claude/skills/orch-perf/learnings.md
- [x] P42 graph pane stays closed after the user closes it | fixed: 2026-11-16 4cb6107 f37c7ea | check: grep -q "isOnce" ../herdr-mods/src/herdr/paneLifecycle.ts
- [x] P44 run page prefs are global | fixed: 2026-11-16 419f7e6 | check: bun test src/web/lib/graph-prefs.test.ts
- [x] P45 cron expression shows its meaning | fixed: 2026-11-16 8c79174 | check: bun test src/web/lib/cron-text.test.ts
- [x] P43 agent output keeps colour (pty, ANSI log) | fixed: 2026-11-16 7202a9e | check: bun test skills/orch/core/commands/herdr-launch.test.ts src/web/lib/ansi.test.ts
- [x] P6 parallel cap 15 | fixed: 2026-11-16 profile-defaults | check: grep -q "auto_dispatch_max_parallel" src/server/runs/auto-dispatch.ts
- [x] P1 CLI call takes seconds (run status 0.356 s, node update 0.215 s, batch x10 0.478 s, help 0.083 s at load 19; was 7.1 s) | fixed: 2026-11-16 7e0d55d | check: bun scripts/bench-status.ts 0.5
- [ ] P7 early end resumes the same session | fixed: - | check: bun skills/orch/tests/run.ts lessons
- [x] P9 retry keeps the prompt and prepends unread answers | fixed: 2026-11-16 da06bc6 | check: bun test skills/orch/tests/core-gaps
- [ ] P12 asks are answered fast (bridge delivers) | fixed: - | check: bun skills/orch/tests/run.ts coordinator
- [ ] P14 coordinator repoint by session id | fixed: - | check: bun skills/orch/tests/run.ts coordinator
- [ ] P15 answers reach the retry of an ended node | fixed: - | check: bun skills/orch/tests/run.ts inbox
- [ ] P20 one live job per node | fixed: - | check: bun skills/orch/tests/run.ts lessons
- [x] P21 reset to waiting releases the engine claim | fixed: 2026-11-16 da06bc6 | check: ORCH_HERDR=0 bun test src/server/runs/auto-dispatch.test.ts
- [ ] P22 duration counts only running time | fixed: - | check: bun skills/orch/tests/run.ts timing
- [ ] P23 cards show model, role, tier, effort, cost | fixed: - | check: bun skills/orch/tests/run.ts owner
- [ ] P26 one worktree per code node | fixed: - | check: test -n "$(git worktree list | grep -c take)"
- [ ] P34 tests run dispatch.ts with bun | fixed: - | check: ! grep -rq '"bash", DISPATCH' skills/orch/tests
- [ ] P38 src tests pass (9 fixed in 558646b, rerun pending) | fixed: - | check: ORCH_HERDR=0 bun test --parallel=6 src
- [ ] P40 one tab per node | fixed: - | check: bun test skills/orch/core/adapters/herdr.test.ts
- [ ] P41 dead panels are swept | fixed: - | check: bun test skills/orch/core/adapters/herdr.test.ts
- [x] P47 no shell fake binaries in test support | fixed: 2026-11-16 819322b | check: test -z "$(find src -name '*.sh' -not -path '*/node_modules/*')"
- [x] P48 no stale lib/*.sh mentions in docs | fixed: 2026-11-16 819322b | check: ! grep -rq "lib/runs/.*\.sh\|ORCH_LIB_FILES" skills/orch/SKILL.md README.md
- [x] P49 status line shows orch only for a session that is part of a run | fixed: 2026-11-16 | check: bun test skills/orch/tests/announce/attribution.test.ts
- [x] P50 tests never inherit the real herdr environment | fixed: 2026-11-16 | check: grep -q HERDR_SOCKET_PATH skills/orch/tests/helpers/index.ts
