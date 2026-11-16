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
- [ ] `run status` wall time under 0.5 s on a seeded home; `node update` under 0.3 s; `node batch` of 10 ops under 0.5 s (measure with the bench, load average noted).
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
- [ ] After `service.ts restart`: `/api/build` returns `stale:false`; running jobs survive; a paused run resumes at boot; a stopped run does not.
- [ ] `POST /api/cli` on `<home>/serve/orch.sock` answers `suggest`, `serve status`, `serve config`; fallback to in-process after 150 ms.
- [ ] Run page in a browser (`.claude/skills/verify`): cards show model, role, tier, effort, cost (values, no dashes); family icons; durations are real run time; `starting` state shown; filter, search and summary counts; follow and zoom saved globally; node panel tab saved; cron text in schedules; red only for errors.
- [ ] Watchdog pill: green when ok, amber for unverified or stalled, red only when out of retries; flags clear themselves.
- [ ] Coordinator block on the run page: reachable or unreachable, pending asks, Choose coordinator with two candidates.

## 4. Messaging and failover (herdr bridge)
- [ ] A node ask is typed into the coordinator pane as one line and `delivered_at` is set (`scripts/verify/check-herdr-bridge.ts`).
- [ ] Nothing is typed while the user has text in the input box or the agent is working.
- [ ] Kill the coordinator pane, reopen the session with `opencode --session <id>`: the record repoints by session id and pending asks are redelivered in order with a backlog notice.
- [ ] Two candidate panes: no guess, candidates listed.
- [ ] `node ask --wait 90` returns the answer; after timeout the node continues and a late answer arrives flagged late.
- [ ] An answer to an ended node is prepended to its retry prompt; the same question is not stored twice.
- [ ] One live job per node: a second `node dispatch` is refused; a reset to waiting releases the engine claim (P21 still open).

## 5. Herdr instance, tabs and colour
- [ ] One workspace per run, one tab per node titled `<node-id>` (`#n` above 1), retry reuses the tab.
- [ ] Ended tabs close 300 s after the node ends; orphan panes close after 60 s; the user herdr and the home workspace are never touched (`scripts/verify/check-herdr.ts`).
- [ ] The agent output in the pane has ANSI colour (`herdr pane read`), `log` keeps ANSI, `log.plain` has none, and liveness by log growth still works.
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
- [ ] All `take-*` worktrees and branches are merged and removed (`git worktree list`, `git branch`).
- [ ] The orch run `20261115-114006-0bff` is finished or archived (paused with `auto_dispatch` off today).
