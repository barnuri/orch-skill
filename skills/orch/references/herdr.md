# The dedicated orch herdr instance

Orch runs jobs in panes of its **own** herdr server, never in the user's live herdr session.
Code: `scripts/lib/herdr.sh`. Tests: `scripts/herdr-runner.test.sh`.

## Layout
`<orch-home>/herdr/` holds `home/` (the instance's `HOME`), `server.pid` and `server.log`.
- Own `HOME` means own `~/.config/herdr/`: `config.toml`, `herdr.sock`, `session.json`.
- Unix socket paths must stay under 104 bytes. When `<orch-home>/herdr/home/.config/herdr/herdr.sock`
  is longer than 100 bytes, the instance `HOME` is the symlink `/tmp/orch-herdr-<uid>-<cksum>`.
- Every orch call goes through `herdr_cli`, which runs `env -i PATH HOME=<inst> ... herdr`. That drops
  `HERDR_SOCKET_PATH` and the other `HERDR_*` variables of a calling pane, so the live socket is unreachable.

## Config and forbidden plugins
`config.toml` is written once, minimal: `onboarding = false` and `[ui.toast] delivery = "off"`.
A fresh `HOME` has no plugins. Never `herdr plugin link` anything into it, never copy
`~/.config/herdr` into it, and never use `--session` of the live server (that shares the user's
config and would load the herdr-folders sidebar, project manager and notification plugins).
Orch notifies through its announce daemon and `msg` mailbox.

## Lifecycle
- `dispatch.sh herdr ensure` (also called by `start`): starts `herdr server` headless through
  `run_detached` (own session, never a child of the dashboard). Single flight (lock `herdr-ensure`),
  idempotent. A stale socket from a crashed server is moved aside, not deleted.
- `dispatch.sh herdr stop`: `herdr server stop`. `herdr status` / `herdr attach`: print state, home, log and
  the attach command: `env -u HERDR_ENV ... HOME=<inst> herdr` in a separate terminal.
- Jobs: `herdr_start_job` creates the pane (workspace `orch`, tab = run id or `jobs`), renames it
  `<run> <node> <job-id>`, and types `bash <job_dir>/herdr-launch.sh`. The launcher restores the real
  `HOME` and the job env (`ORCH_*`, `HARNESS_ORCH_*`, PATH, a short allow-list), unsets `HERDR_*`,
  writes `pid`, and execs the job wrapper. **The wrapper, not the pane, writes `log` and `exit_code`.**
  Job dir also gets `herdr_pane`, `herdr_home`, `herdr_sock`.
- Pane lifecycle: a background closer closes the pane `ORCH_HERDR_CLOSE_AFTER` s (default 60) after exit 0;
  failed or killed jobs keep the pane. Cap `ORCH_HERDR_PANE_CAP` (default 20) panes in the instance.
- Pane state is never authoritative. After a reboot the instance and its panes are gone; `run sync`
  finds a job with no pid and no `exit_code`, marks the node error and appends a `note` event
  ("job process gone without an exit code; its orch-herdr pane ... is gone; the host rebooted ...").

## Herdr web plugin: environment "orch-skill"
`herdr_orch ensure` (every call) writes `~/.config/herdr-web/envs.d/orch-skill.json`
(`ORCH_HERDR_WEB_ENVS_DIR` overrides the directory; tests always set it):
`{"id":"orch-skill","label":"orch-skill","home":<instance HOME>,"socket":<instance socket>}`, with the
short `/tmp/orch-herdr-...` symlink path when the instance uses it. It is written to a temp file and
renamed, never fails the caller, and is skipped when herdr use is off (`ORCH_HERDR=0`). `herdr_orch stop`
trashes it. A stale file is harmless: the web plugin lists only reachable envs (and the plugin also
auto-lists the same instance as `orch`). The web UI then shows an env named **orch-skill** in its env
selector, with the orch workspace, one tab per run and one pane per job. Verify without restarting
the live plugin: `curl http://localhost:7936/api/envs` (default port 7936; see the plugin config) and
look for `"id":"orch-skill"` (the web plugin re-reads the directory within about 5 s).

## Fallback and switches
Detached (`run_detached`) whenever herdr is not on `PATH`, `ensure` fails, the pane cap is reached or a call fails.
- `ORCH_HERDR=0` (or `off`) disables; `ORCH_HERDR=1` forces on; otherwise `settings.herdr`
  (`orch herdr on|off|auto`), and with neither set it is on exactly when the binary exists.
- Other env: `ORCH_HERDR_CLOSE_AFTER`, `ORCH_HERDR_PANE_CAP`, `ORCH_HERDR_START_WAIT`, `ORCH_HERDR_CALL_TIMEOUT` (s).
  Tests export `ORCH_HERDR=0` in `scripts/test-lib.sh` so no test starts a server by accident.
- Not covered: schedule `command` runs (plain shell, no job dir) stay detached.

## Cost (measured, real herdr 0.9.5)
See the report of the restart-safety-herdr node: about 25 MB RSS and ~0% CPU idle for one workspace.
