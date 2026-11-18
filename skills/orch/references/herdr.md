# The dedicated orch herdr instance

Orch runs jobs in panes of its **own** herdr server, never in the user's live herdr session.
Code: `core/adapters/herdr.ts`. Tests: `core/adapters/herdr.test.ts`.

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
- `dispatch.ts herdr ensure` (also called by `start`): starts `herdr server` headless through
  `run_detached` (own session, never a child of the dashboard). Single flight (lock `herdr-ensure`),
  idempotent. A stale socket from a crashed server is moved aside, not deleted.
- `dispatch.ts herdr stop`: `herdr server stop`. `herdr status` / `herdr attach`: print state, home, log and
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
  Tests export `ORCH_HERDR=0` in `tests/helpers/index.ts` so no test starts a server by accident.
- Not covered: schedule `command` runs (plain shell, no job dir) stay detached.

## Fallback and switches
Detached (`run_detached`) whenever herdr is not on `PATH`, `ensure` fails, the pane cap is reached or a call fails.
- `ORCH_HERDR=0` (or `off`) disables; `ORCH_HERDR=1` forces on; otherwise `settings.herdr`
  (`orch herdr on|off|auto`), and with neither set it is on exactly when the binary exists.
- Other env: `ORCH_HERDR_CLOSE_AFTER`, `ORCH_HERDR_PANE_CAP`, `ORCH_HERDR_START_WAIT`, `ORCH_HERDR_CALL_TIMEOUT` (s).
  Tests export `ORCH_HERDR=0` in `tests/helpers/index.ts` so no test starts a server by accident.
- Not covered: schedule `command` runs (plain shell, no job dir) stay detached.

## herdr-core (hc) terminals
When `hc` is on `PATH`, `startJob` first runs the job as an hc terminal: `hc run --bg --json --cwd <cwd>`
with labels `orch=1`, `run=<run>`, `node=<node>`, `job=<job dir name>`. The address goes to `<job>/hc_term`.
The job still runs the same launcher (`herdr-launch.sh`), and the wrapper writes `log` and `exit_code`.
- `hc ls --json --label orch=1` lists the orch terminals. `hc read <addr>` reads one's output.
  Pane cap (`ORCH_HERDR_PANE_CAP`) applies to these terminals too.
- `hcSweep` runs `hc rm <addr>` for a job that has ended (`exit_code` mtime older than the linger),
  then trashes `hc_term`. A running job is never removed.
- Switches: `ORCH_HC=0` turns the hc path off. `ORCH_HC=1` turns it on. `ORCH_HERDR=0` turns it off too.
  With neither set, it follows `ORCH_HERDR` and `settings.herdr`. No `hc` on `PATH` means off.
- Fallback: any hc failure (`hc run` error, no address, pane cap, `hc ls` error) falls through to the
  herdr path above. No `hc_term` file is written then, and the job gets `herdr_pane` as usual.

## Cost (measured, real herdr 0.9.5)
See the report of the restart-safety-herdr node: about 25 MB RSS and ~0% CPU idle for one workspace.

## hc jobs in the Herdr desktop app

`herdr-app` shows an hc terminal only when it carries `herdr.space=<space id>` (and `herdr.tab=<tab id>`).
When the hc path starts a job and `herdr-app` is on PATH and `herdr-app status` answers, orch:

- resolves the space named `settings.herdr_space` (profiles.json settings, default `orch`; `off` or empty disables)
  with `herdr-app ls`, or creates it once with `herdr-app do space.new --name <name> --folder <cwd> --focus false`.
  The id is cached per orch process for 60 s and re-resolved when it is gone.
- creates one tab per run (`herdr-app do tab.new --name <run> --space <id> --focus false`), cached per run.
  The tab also holds one default shell terminal that the app creates.
- starts the job with `hc run --bg --name <run>-<node>-<job> --label herdr.space=<id> --label herdr.tab=<id>`.
  The job dir gets an `hc_app` file.

Any herdr-app failure writes one `orch: herdr-app: ...` line to the job `log` and the job runs as a hidden
worker. Focus, layout and the user's tabs and spaces are never changed or closed. `hcSweep` removes a successful
job's terminal as before and keeps a failed job's terminal (job has `hc_app`, exit code not 0) visible.
