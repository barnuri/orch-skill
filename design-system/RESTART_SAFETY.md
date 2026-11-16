# Restart safety audit and plan (read-only audit; no repo file edited)

## Findings
- F1 (measured) launchd `kickstart -k` kills the server's whole process group. The plist (scripts/service.ts:239-243) has KeepAlive, ThrottleInterval and no AbandonProcessGroup/ProcessType. Probe with a throwaway label (bootstrapped, then booted out): a plain `sleep &` child died; a child started with POSIX::setsid survived. systemd unit (service.sh:340) sets Restart=always and no KillMode, so the default control-group applies and every child dies, setsid or not, unless `KillMode=process` is set. Gap on Linux.
- F2 `dispatch.ts start` jobs use run_detached (dispatch.ts:399-410, setsid or perl setsid), so they survive on macOS. They are not safe on systemd (cgroup kill).
- F3 Schedule ticker (schedules/ticker.ts:20) spawns a short `dispatch.ts schedule tick`; the jobs it starts are detached through `start`. It dies mid-tick only. The tick must stay idempotent.
- F4 Chat turns: claude-session.ts:73 `Bun.spawn` is NOT detached, so it dies on restart; stdout/stderr are pipes to the server, so even detached children (opencode-session.ts:99, turn-session.ts:198) get SIGPIPE/EPIPE on the next write and lose the answer. Nothing is persisted but the DB rows.
- F5 Boot recovery of chats: store.ts:240 `recoverStreaming()` marks every streaming/pending message `error: server restarted` and sets all chats idle. Honest, but it destroys an answer that is still running (a lie in the other direction: the process may still live and finish). SSE does support Last-Event-ID (chats.controller.ts:283, sse.ts), replayed from the DB.
- F6 Runs: the reconciler (runs/run-reconciler.ts:31) calls `dispatch run-reconcile` per run via spawn. It is read-only toward the work and flips finished jobs from status files, so it re-adopts surviving jobs. job_status (dispatch.ts:366) says `done exit=unknown` when the pid is gone with no exit_code, so a lost job after a reboot is reported honestly.
- F7 Existing herdr support: core/adapters/herdr.ts + `settings.herdr`. `herdr_main` (herdr.sh:13) unsets HERDR_* and talks to the USER's default socket, creating workspace "orch" in the user's live session. This violates the new requirement and must be repointed (see Design). It is opt-in and off by default. The launcher writes `pid` itself and the job writes exit_code through the start script, so the status contract is already wrapper-based. Pane id is stored in job_dir/herdr_pane. Fallback to detached already exists (herdr_start_job returns 1).
- F8 The announce daemon (announce.pid/announce.log in the orch home) was not audited. Check whether it is started with run_detached before relying on it (open risk).

## What survives a dashboard restart today
| Thing | macOS launchd | Linux systemd | Lie left behind |
|---|---|---|---|
| `start` jobs (detached) | survive | killed (cgroup) | no exit_code -> "done exit=unknown" (honest) |
| Runs/watches state.json | survive, reconciler re-reads | same | none |
| Ticker-started runs | survive; a tick in flight dies | same | a half-done tick is retried next minute |
| Chat: claude turn | dies | dies | row marked error "server restarted" |
| Chat: opencode/turn-session (detached) | process lives, pipe breaks, answer lost | dies | error row; the work may be done silently |
| Loops | detached via stop_group (setsid) | assumed same as `start` | not verified |
| `dispatch.ts ui` nohup server | survives | n/a | races with the supervisor (noted in CLAUDE.md) |

## Design: a dedicated orch herdr instance (never the user's)
Isolation (measured, with a temp HOME): `env -i PATH=... HOME=<orch-home>/herdr/home herdr server` runs headless. It needs no TTY and no tmux. That was verified with the process started under setsid with stdin /dev/null. `herdr status --json` showed its own socket `<HOME>/.config/herdr/herdr.sock`. The live server (pid 1617) was never touched. `workspace create`, `pane run`, `server stop` all worked. The demo needs tmux only to attach a client, not to run the server.
- Rejected: `--session <name>` (shares the user's config.toml and plugins, so the herdr-folders sidebar would load). HERDR_CONFIG_PATH alone does not move the socket or sessions.
- State lives in `<orch-home>/herdr/home/.config/herdr/` (socket, session.json, server log, config.toml). Unix socket paths must stay under 104 bytes: `/Users/<user>/.harness-orch/herdr/home/.config/herdr/herdr.sock` is about 70 chars. For long paths, symlink `/tmp/orch-herdr-<uid>` to the home.
- Minimal config.toml: `onboarding = false` and `[ui.toast] delivery = "off"`. A fresh HOME has no plugins (`herdr plugin list` = none), so the herdr-folders sidebar, project-manager and notification plugins are NOT loaded. Never `plugin link` anything and never copy ~/.config/herdr. No notifications: orch's announce daemon notifies already.
- HOME pitfall (measured): a pane inherits HOME=<temp>, so the agent would see the wrong ~/.config, credentials and git config. The launcher must `export HOME=<real home>` (record it at `ensure` time) and must not rely on the pane env. The existing launcher exports only ORCH_/HARNESS_ORCH_/PATH, so HOME, plus anything the adapters need, must be added.
- Alive independently of the dashboard: `dispatch.ts herdr ensure` starts the server through run_detached with a pidfile `<orch-home>/herdr/server.pid`; no dependency on the dashboard. Optional second unit (launchd `com.orch.herdr`, KeepAlive, AbandonProcessGroup true; systemd `orch-herdr.service`, KillMode=process) for reboot revival. Both are optional; `start` calls `ensure` lazily.
- Look at it: `env -i PATH="$PATH" HOME=<orch-home>/herdr/home herdr` in a separate terminal (the user's live herdr is not involved; never nested inside the live pane). Note for later: a dashboard "Open orch herdr" button (out of scope).
- Cost (measured, idle, one workspace): about 23 MB RSS, 0.3% CPU.
- Pane layout: one workspace `orch`, one tab per run (`ORCH_RUN_ID`) or `jobs`; panes titled `<job-id> <node>`. Cap 8 panes per tab, then a new tab; cap 40 total, then fall back to detached. Success: the pane closes after N=300 s (setting) through a wrapper `sleep N; herdr pane close`. Failure: the pane stays until the user closes it. Pane state is never authoritative.
- Exit reporting: the wrapper/start script writes exit_code in job_dir (as now). The server finds the pane through job_dir/herdr_pane and the herdr socket path through job_dir/herdr_sock (new).
- Server independence: every herdr call is best-effort with a 3 s timeout; failure means fallback to `run_detached` (setsid, never a server child). Reboot: the herdr server and its panes die, so jobs lose pid; job_status prints `done exit=unknown (...)` honestly. Add "host rebooted" wording by comparing the boot time to the job start (optional).
- Chat turns (smallest scheme): start the harness detached (herdr pane or setsid) with `> <home>/chats/turns/<turn-id>.jsonl` and a `<turn-id>.pid` plus `<turn-id>.exit`. The server tails the file (offset stored in the DB), and persists deltas as now. On boot, instead of `recoverStreaming` blanket-failing: for each streaming row with a turn file, if pid is alive then re-attach the tail; else finalize from the file (exit file present: done/error with the parsed text; not present: `interrupted`, keeping the partial text). Rows without a turn file keep the current behavior. Stdin-driven claude sessions (pipe stdin) need a FIFO or the `-p` per-turn mode; this is the largest risk.

## Plan (hours)
| # | Task | Files | Area | Parallel-safe now | Test | Risk | h |
|---|---|---|---|---|---|---|---|
| 1 | systemd KillMode=process; plist AbandonProcessGroup=true | scripts/service.ts | service.sh | yes | fake supervisor test + the launchd probe above | low | 1 |
| 2 | Repoint herdr to a dedicated instance: ensure/stop/status, HOME in launcher, caps, auto-close, herdr_sock file | skills/orch/scripts/core/adapters/herdr.ts, dispatch.ts | bash scripts | NO, wait (others edit scripts/**) | fake herdr binary as in herdr-folders tests; assert the user's socket is never used | med | 5 |
| 3 | Ticker/`start` through the same path; ensure tick idempotency | src/server/schedules/ticker.ts, scripts | schedules + scripts | partly: ticker.ts is yes, scripts wait | fake dispatch | low | 2 |
| 4 | Chat turns to turn files, tailer, boot re-attach, `interrupted` status | src/server/chats/**, store.ts | chats | NO, wait | fake harness writing jsonl; kill and boot the server in a test | high | 10 |
| 5 | Reconciler: show a pane-gone/boot note | src/server/runs/run-reconciler.ts | runs | NO, wait | unit | low | 2 |
| 6 | Verify announce daemon + loops detachment | skills/orch/scripts/lib | scripts | read-only audit yes | script | low | 1 |
| 7 | Docs: SKILL.md, references (dedicated instance, config, forbidden plugins) | skills/orch/SKILL.md, references/ | docs | after 2 | n/a | low | 1 |
| 8 | Full restart gate | scripts/test-all.ts | all | last | real: restart the service with a running job | low | 1 |

Start NOW: 1 and 3 (ticker.ts only), 6. Wait: 2, 4, 5, 7.

## Open risks
- herdr 0.9.5 headless server behavior across herdr updates ("restart_needed", live handoff) could restart the orch server and kill panes.
- Pane env and HOME mismatch (see above); secrets must not be written to the launcher beyond the existing allow-list.
- Socket path length; a stale herdr.sock after a crash needs `ensure` to probe and remove it with trash.
- Keeping claude's stdin pipe alive across server restarts is not possible without a FIFO or a per-turn mode.
- The announce daemon was not audited (F8).
