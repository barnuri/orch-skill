# To verify (code that exists but was not proven)

Everything below was written or merged without a live check, because the session ran tests only at the
end. Tick a box only with evidence (command output). Source of truth for open items: this file,
`agent-spec/unorch/<run>/tasks.md` (local), `.claude/skills/orch-perf/checklist.md` and `problems.md`.

How to use: `bun scripts/orch-perf.ts --recheck` runs the `check:` commands of the checklist. The rows
here are the ones a check cannot cover (live behaviour, UI, herdr, hub).

## 1. Test suites and gates
- [ ] `bun scripts/typecheck.ts` prints `typecheck: ok` on `master`.
- [ ] `ORCH_HERDR=0 bun test --parallel=6 src` has 0 failures, under 3 minutes.
- [ ] `bun skills/orch/tests/run.ts` (fast tier) passes in under 30 s; `--full` passes in under 5 minutes (exit 0, or 75 then `--resume` until 0).
- [ ] No test file takes more than 20 s (`bun scripts/test-bench.ts`, top 10 slowest).
- [ ] `bun scripts/test-all.ts` passes (bash-free).
- [ ] No `.sh` file remains except data: `find . -name "*.sh" -not -path "./node_modules/*" -not -path "./.git/*"` is empty (the 4 fake CLI binaries were converted in 819322b; `jobs/<id>/herdr-launch.sh` is a generated runtime file, not a repo file).

## 2. Bun port parity (the bash oracle is gone)
- [x] `run status` wall time under 0.5 s on a seeded home; `node update` under 0.3 s; `node batch` of 10 ops under 0.5 s (measure with the bench, load average noted). EVIDENCE: bun scripts/bench-status.ts 0.5 exit 0: status 0.356 s, update 0.215 s, batch x10 0.478 s, help 0.083 s, load 19 (2026-11-16)
- [ ] Every command of the old usage text still exists: compare `dispatch.ts --help` with the usage in `skills/orch/SKILL.md` and the table in `core/cli.ts`.
- [ ] `run sync`, `run advance`, `run retry`, `node dispatch` behave as the bash version did: start a tiny run with the fake adapter and walk it to done.
- [ ] `hub_node_expect` equivalent exists (the hub expectation record at node dispatch was dropped in the port).
- [ ] `ensureHome` runs all profile migrations (the serve port skipped them): fresh home and an old-format profiles.json.
- [ ] Demo status writes: `next_retry_at` and owner files are written like `node_set_status` did.
- [ ] `suggest_apply_safe` runs after `run finish` (it was skipped).
- [ ] `ORCH_RESUME_SESSION` resume path works for a retried node.
- [ ] Bun missing: `PATH` without bun prints `orch requires bun (https://bun.sh)` (the install script and the shebang case).

## 3. Service and dashboard
- [ ] `bun scripts/service.ts install|restart|status|logs|uninstall` on macOS (launchd plist has `AbandonProcessGroup`) and on Linux (systemd `KillMode=process`).
  - Open. 2026-11-16: only `status` run (macOS): `supervisor: state = running, pid = 94099`, `listener on 127.0.0.1:6724: answering`. install/restart/uninstall not run (the user's service must not be restarted), Linux not available.
- [ ] After `service.ts restart`: `/api/build` returns `stale:false`; running jobs survive; a paused run resumes at boot; a stopped run does not.
  - Open. 2026-11-16: `bun scripts/verify/check-api.ts` -> `FAIL build stale:true: ["commits","files"]` (service booted 12:29, many commits since; restart not done on purpose). A second server on port 6799 with a temp home answered `/api/build` `{"stale":false}`, `/api/watchdog` `state: on`.
- [ ] `POST /api/cli` on `<home>/serve/orch.sock` answers `suggest`, `serve status`, `serve config`; fallback to in-process after 150 ms.
  - Open: not run.
- [ ] Run page in a browser (`.claude/skills/verify`): cards show model, role, tier, effort, cost (values, no dashes); family icons; durations are real run time; `starting` state shown; filter, search and summary counts; follow and zoom saved globally; node panel tab saved; cron text in schedules; red only for errors.
  - Open (partly proven). 2026-11-16, temp-home server on :6799, `ORCH_URL=http://127.0.0.1:6799 bun scripts/verify/check-run-page.ts 20261116-155509-5273 claude-opus-4 '$0.43' coder smart high "Ship the payments service"` -> 7 x PASS. Card text read from the page: `claude-opus-4`, `15.4k tok · $0.43`, `high · coder · smart`; unreported nodes show `model not reported` / `usage — · cost —`; summary `4/7 done`; `ready, not started` state. Not checked: family icons, durations, filter/search, follow/zoom/tab persistence, cron text, red colour.
- [ ] Watchdog pill: green when ok, amber for unverified or stalled, red only when out of retries; flags clear themselves.
  - Open: only `GET /api/watchdog` -> `state: on` and the header text `watchdog· node retry ...` seen; colours not checked.
- [ ] Coordinator block on the run page: reachable or unreachable, pending asks, Choose coordinator with two candidates.
  - Open (partly proven). `GET /api/runs/20261116-155509-5273` (run with a coordinator) -> `.run.coordinator_state = {pane_id:"w9:p1",reachable:true,pending_asks:0,last_repoint:null,candidates:[]}`; page text `coordinator w9:p1 / reachable / 0 pending node questions`. Note: `reachable` reflects the stored `unreachable` record only, not a live probe. Unreachable and Choose coordinator not exercised.

## 4. Messaging and failover (herdr bridge)
- [x] A node ask is typed into the coordinator pane as one line and `delivered_at` is set (`scripts/verify/check-herdr-bridge.ts`).
  - `bun scripts/verify/check-herdr-bridge.ts` (throwaway run, coordinator = fake-agent pane in a temp-home orch herdr instance): `PASS ask m1 delivered_at 2026-11-16T15:51:08Z`, `PASS one-line format: > [orch ask #m1 from n1] is the bridge alive? | answer: dispatch.ts node answer br1 n1 m1 ...`.
- [x] Nothing is typed while the user has text in the input box or the agent is working.
  - Same script: `PASS busy: m2 deferred (coordinator pane is working)`, `PASS busy: m2 delivered after idle`, `PASS typing: m3 deferred (coordinator is typing or the screen is changing)`, `PASS typing: m3 delivered after the input cleared`.
- [ ] Kill the coordinator pane, reopen the session with `opencode --session <id>`: the record repoints by session id and pending asks are redelivered in order with a backlog notice.
  - Open (partly proven). Same script: `PASS repoint: coordinator now w2:p1 (same harness and repo), m4 delivered` after the first pane was closed. Not proven: repoint by session id (herdr 0.9.5 does not show `agent_session` for a pane reported with `report-agent[-session]`, so the check used the harness+repo match; unit test `tests/unit/coordinator.test.ts` covers session id), real `opencode --session`, in-order redelivery and the backlog notice.
- [ ] Two candidate panes: no guess, candidates listed.
- [ ] `node ask --wait 90` returns the answer; after timeout the node continues and a late answer arrives flagged late.
- [ ] An answer to an ended node is prepended to its retry prompt; the same question is not stored twice.
- [ ] One live job per node: a second `node dispatch` is refused; a reset to waiting releases the engine claim (P21 still open).

## 5. Herdr instance, tabs and colour
- [ ] One workspace per run, one tab per node titled `<node-id>` (`#n` above 1), retry reuses the tab.
  - Open (partly proven). `bun scripts/verify/check-herdr.ts --lifecycle`: `PASS one workspace for the run (lf1)`, `PASS one tab titled n1 (n1)`, `PASS one pane (1)`. Retry reuse and `#n` not run live (unit test only).
- [ ] Ended tabs close 300 s after the node ends; orphan panes close after 60 s; the user herdr and the home workspace are never touched (`scripts/verify/check-herdr.ts`).
  - Open (partly proven). `--lifecycle` with `herdr_linger_sec=5` in a temp home: `PASS tab closed after the 5 s linger`, `PASS orphan pane swept after 60 s`. The 300 s default and the user herdr being untouched were not measured (only the temp-home instance was used). Two bugs found live and fixed (commit 4b2540b carries them): the orch herdr server was a child of the dispatch process and died with the caller's process group (now `detached: true`), and `sweep` matched a reused pane id (`w1:p2` restarts with every server) to the oldest job so the tab was never closed (now the newest job dir wins).
- [ ] The agent output in the pane has ANSI colour (`herdr pane read`), `log` keeps ANSI, `log.plain` has none, and liveness by log growth still works.
  - Open (partly proven). `--lifecycle`: `PASS pane output has ANSI colour codes` (`herdr pane read --format ansi`: `38;5;1mred`), `PASS log keeps ANSI`, `PASS log.plain has no ANSI`. Liveness by log growth not checked live.
- [ ] The orch graph pane stays closed after a manual close (herdr-mods `--once`), reopens on `/orch-graph`.

## 6. Profiles, models and cost
- [ ] Pinned profiles answer: `profile sanity` for `opencode-opus-plan`, `opencode-haiku-exec`, `opencode-sonnet-verify`.
- [ ] `profile show <name> --effective` prints each value with its source; `defaults.max_parallel` is 15 and caps auto-dispatch (also per profile).
- [ ] The committed `templates/profiles.json` has no personal models; `profile sync-overlay` adds or replaces overlay profiles.
- [ ] Hub selection events fill `actual_model`, `role`, `tier`, `effort` for new nodes; old nodes backfilled (173 were empty).
- [ ] Cost of one session is counted once across two bound nodes.

## 7. Process and learning
- [ ] `bun scripts/orch-perf.ts` appends a block; `--recheck` runs and flips a broken fixed row to `[!]`.
- [ ] Schedules `orch-perf-daily` and `orch-learn-from-runs` run and write their output.
- [ ] `bun scripts/unorch.ts` writes `tasks.md`, `asks.md`, `handoffs/` and pauses the run.
- [ ] Skills load: `unorch` (plugin manifest), `verify` (repo skill under `.claude/skills`), `orch-perf`.
- [x] All take-* and wt-* worktrees and branches merged and removed (done, only master and the user-kept cp2 worktree remain)
- [ ] The orch run `20261115-114006-0bff` is finished or archived (paused with `auto_dispatch` off today).
- [ ] Chat folders (chat cwd, project default, picker, chips): run a real claude, pi and opencode chat in a folder under ~/sandbox/private, open the picker on a phone, move a chat and check the next turn cwd; `PUT /api/projects/{id}` has no roots check; `chat_roots` has no settings UI
