# orch-skill — Repo Notes

A single-skill Claude Code plugin. The skill itself lives at `skills/orch/`; everything at the
repo root is packaging (install + optional service + docs).

## Language: Bun and TypeScript only

All scripts, entry points, tests, tools and future code in this repo are written in TypeScript and run with Bun. Do not add shell, Python or other scripts. Entry points are executable `.ts` files with a `#!/usr/bin/env bun` shebang. Tests use `bun test`. Bun is required: `command -v bun` must succeed. When it is missing, `dispatch.ts` exits 127 with "orch needs bun: install it from https://bun.sh (...)", `install.ts` refuses to install, and SKILL.md Step 0 tells the user the same. `dispatch.ts doctor` prints the bun version, home path and herdr availability. There is no bash fallback. The only non-TypeScript files are data and docs (json, md, css). `dispatch.ts` is the single entry (there is no dispatch.ts and no bin/orch).

## Layout

```
.claude-plugin/marketplace.json   plugin manifest — marketplace `orch-skill`, plugin `orch`
install.ts / uninstall.ts         register/unregister this folder with Claude Code
scripts/service.ts                optional always-on dashboard service (launchd / systemd --user)
scripts/*.ts                      service, typecheck, test-all/budget/fast, heavy-test-lock, lint, precommit-smoke, demo/mod capture;
                                  lib/util.ts holds the shared helpers; verify/*.ts are the repo verify checks;
                                  o.ts, run-nodes.ts, job-tail.ts are coordinator shortcuts (references/subagent-preamble.md):
                                  use them, the `workdir` tool argument (not `cd`) and the edit tool (not python heredocs)
package.json / bun.lock           the dashboard server's dependencies (hono, zod, decorators)
src/                              the dashboard code, kept OUT of the skill so loading the skill never pulls it in
  server/                         Bun + Hono server
    api/                          decorated controllers + zod DTOs: every /api route, validation, OpenAPI; routes/ holds the handlers
    build/                        GET /api/build (is the running server older than the sources?) and POST /api/build/restart
                                  (runs `service.ts restart`; cooldown, log cap)
    chats/                        chat store (bun:sqlite), service, sessions/ (claude, opencode, turn-session, turn-files)
    schedules/                    ticker (runs `dispatch.ts schedule tick`, claim files) + reader
    suggest/                      scan-cache for the suggestions page
    runs/ active/ artifact/ ...   readers and the reconciler; dispatch-path.ts resolves dispatch.ts
    test-support/                 fake-dispatch.ts, temp-home.ts, test-server.ts (tests never touch real state)
  web/                            React 19 dashboard served at / (/next answers 301 -> /)
    shell/                        AppShell, Rail (nav), Header, BuildBanner ("Server out of date"), connection/freshness
    runs/                         runs list, run inspector (graph, node panel, activity)
    chats/                        chat pages, composer, pickers, virtualized thread
    pages/                        profiles, memory, harnesses, schedules, suggestions, settings
    lib/ api/ forms/ components/  shared logic; imports src/shared DTO schemas and types
  snapshot/                       vanilla client, ONLY the renderer of `dispatch.ts artifact` snapshots (island mode);
                                  also owns tokens.css, styles.css, fonts and favicon, which web/ reuses
  shared/                         dto/ (zod), types/, build-commands.ts — must stay Bun-free
design-system/                    makeover exploration: tokens.A/B.css, proto/, audit, plans, RESTART_SAFETY.md
tsconfig.json                     type config for src/server, src/shared and the snapshot tests
mods/orch-graph/                  Claude-Code-only mod: live run-graph pane; loaded via CLAUDE_CODE_PLUGIN_DIRS (install.ts)
skills/orch/
  SKILL.md                        the agent-facing instructions — the actual product
  scripts/dispatch.ts             the CLI (executable TypeScript, `#!/usr/bin/env bun`); every state mutation goes through it
  core/                           the TypeScript CLI: cli.ts (command table), commands/, adapters/, runs/, state/
  core/commands/announce.ts       status announcer (`dispatch.ts announce`)
  tests/run.ts                    the test runner: fast tier (tests/unit/) by default, --changed, --full
  tests/helpers/                  shared TypeScript helpers (seedHome, orch, fakeBin, fakeHerdrBin, fakeHub, ...)
  tests/<category>/*.test.ts      unit/, runs/, adapters/, config/, dashboard/, announce/, automation/, runner/
  references/                     adapter contract + state/config schemas
  templates/profiles.json         seed for ~/.harness-orch/profiles.json
```

`config/` at the repo root is a **gitignored** symlink to the live state directory
(`${HARNESS_ORCH_HOME:-~/.harness-orch}`) — a convenience for reading `profiles.json`,
`memory.json`, `runs/` and `jobs/` while working in the checkout. It points at an absolute
per-machine path, so it must never be committed; `install.ts` creates it and `.gitignore` blocks
it. Reading through it is fine; writing to `runs/` or `jobs/` through it is not (see Invariants).

Adding a skill would mean appending it to `plugins[0].skills` in
`.claude-plugin/marketplace.json` — a skill on disk that is missing from the manifest is not
loaded.

## Invariants

**`dispatch.ts` owns every mutation.** The dashboard reads `~/.harness-orch` live and assumes the
files are only ever written through a subcommand. Never hand-edit `runs/<id>/state.json`,
`jobs/<id>/*`, `profiles.json` or `memory.json` from a script or a test, and never add a code
path that writes them directly — add or extend a subcommand instead. Callers (including SKILL.md)
must not re-implement what the script already does.

**Exception: chat history.** Chat history in `<home>/chats.db` (with uploads under `<home>/chats/files/`) is written only by the dashboard server, through `bun:sqlite`. This is an explicit exception to "`dispatch.ts` owns every mutation": no subcommand writes it. It is never pruned, `prune` and the retention settings do not touch it, and nothing deletes a row (archive and hide only).

**Claim files.** The schedule ticker (server) writes `<home>/schedules/<id>/claims/<next_at>` with an
exclusive create before it fires a schedule (fire id `id@next_at`), so a double tick or a second server
fires once. Like chat history, these are server-written, not `dispatch.ts`-written.

**Owner registry.** `<home>/owners/<session-id>.json` maps an owner session to its run and node. It is
written by `owners.sh` (`owner_registry_write`), filled by `dispatch.ts node bind-owners`, and checked by
`node verify-owners`. Go through those subcommands.

**Restart spares jobs.** A dashboard restart must not kill job processes. The launchd plist sets
`AbandonProcessGroup`, the systemd unit `KillMode=process`, and `dispatch.ts start` jobs are detached.
`service.ts install` now rewrites a unit that lacks these (`unit_installed_for_checkout`), so re-run it
after pulling. Design and audit: `design-system/RESTART_SAFETY.md`. Status of its parts: the dedicated
herdr instance runner (`lib/adapters/herdr.sh`: own HOME, `server.pid`, `jobs/<id>/herdr_pane` and `herdr_sock`)
is on disk; chat turn files (`chats/sessions/turn-files.ts`, boot re-attach in `chats/service.ts`,
`interrupted:` rows) are on disk.

**Sourcing is side-effect free.** `dispatch.ts` defines functions when sourced and only runs
`main` when executed directly (`BASH_SOURCE[0] == $0`). Backgrounded `start` jobs depend on this:
they re-source the same file by its resolved real path in a fresh `bash -c`. Anything added at
file scope that *does* something breaks them.

**Nothing is deleted with `rm`.** `prune`, `service.ts uninstall` and `uninstall.ts` all go
through `trash` when available and otherwise move the target under `<state-dir>/.trash/<stamp>/`.
The `serve/pid` marker is *truncated*, never removed.

**Dependencies live at the repo root, never in the skill.** `package.json` and `bun.lock` hold the
dashboard server's packages (`hono`, `@hono/zod-openapi`, `zod`, and `@barnuri/hono-decorators` and
`@barnuri/zod-decorators` from GitHub). The CLI under `skills/orch/` stays dependency-free and must
keep working with none of them installed. `serve_ensure_deps` in `lib/dashboard/serve.sh` installs them on first
use. `typescript` (7.x, the native compiler), `@types/node` and `bun-types` (pinned to the Bun version) are devDependencies; `typecheck.ts` prefers `node_modules` and falls back to Bun's global cache and `PATH`, and SKIPs when none exist.

**Secrets never land in state.** `profiles.json` holds env-var *names* and `${VAR}` references;
interpolation happens at spawn time. `profile show` prints `env` as written. Keep it that way.

**Auth is peer-based, not bind-based.** `http/route.ts:authorized` (run by `api/pipeline.ts:guard`) lets any loopback peer through
without a token (`isLoopbackPeer` reads Bun's `server.requestIP`), and demands the bearer token
from everyone else. `--require-token` / `ORCH_REQUIRE_TOKEN=1` turns the bypass off. Two things
follow: the test server sets `requireToken: true` by default, or every auth assertion would pass
vacuously over loopback; and `urlsFor` only appends `?token=` to a URL whose user will actually
be challenged. Do not replace this with a check on the *bind* host — that would either keep
prompting locally or drop auth for the whole LAN.

**Two backgrounding modes, on purpose.** `run` executes an adapter synchronously (for callers
that are already backgrounded, e.g. a harness's own background-Bash + Monitor); `start`
self-backgrounds via `nohup` and prints a job id (for callers that are not). Don't collapse them.

## After every change: restart the service

The dashboard server bundles `src/web/` once at startup and never re-reads `src/server/`, `src/web/`
or `src/shared/`, so any change under `src/` is invisible until the process restarts. The UI now says
so: a stale server shows a **Server out of date** pill in the header; its panel has a **Restart and
update** button (POST `/api/build/restart`, which runs `service.ts restart`). You still restart as the
last step of a task:

```bash
bun skills/orch/tests/run.ts               # must be 0 failed
bun scripts/typecheck.ts       # must print `typecheck: ok`
bun scripts/service.ts restart             # pick up the change
bun scripts/service.ts status              # confirm: state = running, listener answering
```

Do not use `dispatch.ts ui` for this when the service is installed: it stops the server and starts its
own `nohup` copy, which the supervisor then races. If the unit is not installed there is nothing to
restart; the next `ui` picks the change up.

## Commit and deploy

The service serves a deploy checkout (`~/.harness-orch/deploy/orch-skill`, a detached `git worktree`
that never holds edits), not the working tree, so it shows only committed, tested code.

- The orchestrator commits only after the touched tests and `bun scripts/typecheck.ts` pass. Stage your
  own task's files by path (never `git add -A`, never another session's files such as `mods/orch-graph/**`
  unless the user asked), no co-author, never rewrite history. No commit permission means no commit.
- Push tested master commits to `origin` right after the commit (the user allowed it, 2026-11-24). GitHub
  Actions (`.github/workflows/ci.yml`: typecheck and the fast tier) is the gate. There are no local git hooks.
- Deploy through `bun scripts/deploy.ts [--ref REF] [--dry-run]` (default ref `origin/master`). It fetches,
  then reads the commit's GitHub checks: all green deploys, any running waits (exit 0, nothing recorded), any
  failed refuses. Then it updates the checkout, links or installs `node_modules`, points the service at the
  checkout (`service.ts restart --root`), waits for `/api/build` to report the sha, and on any failure keeps or
  restores the previous sha and exits 1. A local ref (no origin) runs the local typecheck and fast tier instead;
  `ORCH_DEPLOY_LOCAL_CHECKS=1` adds them to the GitHub gate. State: `deploy/current.json`, `deploy/history.jsonl`,
  `deploy/lock.d`. Never run `service.ts restart` on the working tree.
- The watchdog checks every 2 minutes (`ORCH_DEPLOY_WATCH=0` turns it off) and starts `deploy.ts` when
  `origin/master` is past `current.json`.
- The header shows `deployed <sha>`, `N commits behind master` and `deploy failed: <reason>` (from `/api/build` `deploy`).
- A restart is safe while a run is active: the service pauses running runs on SIGTERM and resumes
  `auto_resume` runs at boot (stopped runs stay stopped).

## Learn from runs

Review finished runs once a day and after any run longer than 2 hours. Look for idle time caused by wrong
statuses, missed notifications or bugs, and fix the cause in the skill or dispatcher. The orch skill must
run deterministic steps (tests, commits, restarts, status reads) directly and start every ready node at
once. The rule text is in `skills/orch/SKILL.md`, section "Learn from runs, and keep them fast".

## Verification

Use the `verify` repo skill (`.claude/skills/verify/SKILL.md`: browser, herdr and herdr-web checks). Its scripts live in `scripts/verify/`.

## Tests

The skill tests are TypeScript: `skills/orch/tests/<category>/*.test.ts` (unit, runs, adapters, config, dashboard, announce, automation, runner, parity), run by `bun skills/orch/tests/run.ts`. Each file runs as its own `bun test` process in a parallel pool. Shared helpers (`seedHome`, `tempHome`, `orch`, `cli`, `dispatch`, `fakeBin`, `fakeAdapter`, `fakeHerdrBin` (a TypeScript fake herdr), `fakeHub`, `opencodeFixture`, `waitUntil`, `normState`) are in `skills/orch/tests/helpers/index.ts`. Tests drive the CLI as a black box in a temp home (`dispatch.ts` routes to `bun skills/orch/core/cli.ts`), so they stay valid while the bash libs are removed. The `parity/` cases now run every case line on two fresh homes and require identical output and home tree.

```bash
bun skills/orch/tests/run.ts               # FAST tier (default, under 30 s): tests/unit/*.test.ts only
bun skills/orch/tests/run.ts --changed     # fast tier + tests mapped from changed files (changed-map.txt; git diff + untracked)
bun skills/orch/tests/run.ts --full        # every category, slowest first, 300 s budget
bun skills/orch/tests/run.ts --resume      # after exit 75: run only the files not yet passed
bun skills/orch/tests/run.ts wait pause    # only files whose id (<category>/<name>) contains a fragment
bun test --timeout 300000 --parallel=6 --retry=1 src   # TypeScript suite (bun run test; --retry=1 absorbs known load flakes only)
bun run test:changed                         # quick local mode: only tests affected by git changes
bun run test:random                          # --randomize, to expose test-order dependence
bun run test:budget                          # TypeScript suite in file chunks, 300 s budget (scripts/test-budget.ts)
bun run test:resume                          # after exit 75: run only the bun files not yet passed
bun test src/web                             # web alone; passes together with the rest now
bun scripts/typecheck.ts                    # must print `typecheck: ok`
bun scripts/test-all.ts                     # all three at once (the full gate; sets ORCH_HERDR=0 for bun); --resume after 75
```

**Budget and resume.** Every test call has a hard 5 minute budget. `--budget <s>` (default 300 with
`--full`) stops starting files when it is used, gives running files 20 s more (`ORCH_TEST_BUDGET_GRACE`),
then kills them. Each file's result (passed, failed, not_run) goes to `${TMPDIR}/orch-test-progress.json`
(bun: `orch-bun-test-progress.json`, test-all: `orch-test-all-progress`). The run prints
`PARTIAL: N of M files, run again with --resume` and exits 75. On exit 75 run `--resume` until it exits
0 or 1. Never raise the budget. A run that runs every file clears the progress file. Tests:
`tests/runner/run-budget.test.ts`.

`tests/run.ts` runs each test file as its own `bun test` job on its own temp homes and merges the tallies. File ids
are `<category>/<name>`. Pass a name fragment to run matching files only, or `ORCH_TEST_JOBS=1` to go serial.
Each file is capped (30 s fast tier, 240 s otherwise, `ORCH_TEST_FILE_CAP`) and killed with its process
group on timeout. The runner prints per-file seconds and the 5 slowest files before the totals line.
A new test file needs only a category folder and the `.test.ts` suffix.

The fast tier lives in `tests/unit/`: `smoke.test.ts` (every core command module loads, the command table is wired, usage lines), plus CLI-behaviour tests, each under 5 s. A new core command gets a test in `tests/unit/` or its category.

`--changed[=ref]` maps each changed path to test files named `<stem>` or `<stem>-*`, plus the extras in
`tests/changed-map.txt`. A path with no mapping (docs, config) runs the fast tier only.

**Rules:** run `--changed` after an edit, the fast tier before a commit, and `--full` once, at the final
gate. On exit 75 resume, never raise the budget. Stop any other test command at 5 minutes (`timeout 300`).
Use `bun test <file>` for TypeScript. Many agents share this machine: five full suites at
once pushed the load to 17-50 and made every run several times slower. Full runs (`test-all.ts`,
`tests/run.ts --full`, `bun run test`) each take a machine-wide heavy-test slot
(`scripts/heavy-test-lock.ts`: lock dirs `${TMPDIR}/orch-test-heavy.N.d`, a dead holder pid frees its slot, `ORCH_TEST_SLOTS`, default 2).
A third run waits and prints who holds the slots. A dead holder frees its slot by itself. Fast, changed
and fragment runs and single bun files take no slot. `ORCH_TEST_LOCK=0` skips the lock.

For a home that only needs to be initialised, call `seedHome()` (`tests/helpers`) instead of `dispatch.ts init`. It copies a template home (built once per process, or `ORCH_TEST_HOME_TEMPLATE`) and skips the 2-4 s first-run migrations. Keep `init` where the test is about init. The runner starts the slowest files first (per-file seconds of the last run, in `${TMPDIR}/orch-ts-test-timings.json`), and `ORCH_TEST_JOBS=N` is a real pool.

Process start latency, not CPU, is the cost, so concurrency is the lever. Route and reader tests that
spawn `dispatch.ts` use `describe.concurrent` with an `afterAll` that stops the servers, and spawn
asynchronously (never `Bun.spawnSync`). Under heavy machine load, timing-based tests can flake
(timeouts, SSE waits): rerun the single file before suspecting your change.

Env seams for tests: `ORCH_DISPATCH` (dispatch.ts path, read per call in `src/server/dispatch-path.ts`;
tests point it at `test-support/fake-dispatch.ts`), `ORCH_SERVICE_SH` (so restart tests never touch the
real supervisor), `ORCH_CHAT_DISPATCH` (dispatch used by chat turn sessions),
`ORCH_CHAT_OPENCODE_DISPATCH=1` (opt the opencode chat harness into the dispatch path), and
`ORCH_HERDR=0|1` (force herdr off/on). Suites use temporary `HARNESS_ORCH_HOME`s, never real state.
`typecheck.ts` exits 0 with a `SKIP:` line when `bun` or `tsc` is absent: a skip is not a pass.

## UI colour and the makeover

Status colour comes only from the `--status-*` tokens in `src/snapshot/tokens.css` (e.g. `--status-done`,
`--status-error`, `--status-stale`, with `-bg`/`-bd` variants). No raw hex in `src/web` or component CSS.
The blue accent means live / primary action and nothing else; do not use it as a status colour.

**Red means error or failure only.** Red (`--status-error`, `--er`, `--erbg`, `--erbd`, any red hex) marks
a node or run in error, a failed request, a failed test or invalid input. Nothing else is red: not a
destructive button (Stop, Cancel, Delete use the amber `--wa` style), not a stalled or unverified flag,
not a skipped or paused run, not an informational state, not a recording indicator (blue accent). Red is allowed for a destructive confirm
button only inside a `<dialog>`. `src/web/colour-red.test.ts` fails when a component CSS rule paints red
on a selector that does not name an error state (scans `src/web` and `src/snapshot`).
The watchdog pill (`src/web/shell/WatchdogPill.tsx`) is red only for a node the watchdog gave up on
(rules `infra-retry` and `lost`). `unverified`, `stalled` and any other flag are amber, off is grey, ok is
green. Watchdog flags clear themselves when their cause is gone (`dropStaleFlags` in
`src/server/watchdog/watchdog-service.ts`), so a stale flag never stays on the pill.
Makeover state: direction B "Signal" is applied to the tokens and UI; the commit is pending approval,
so do not commit or revert it. Sources and prototypes live in `design-system/`.

## The optional service

`scripts/service.ts` generates a supervisor unit that runs `bun dispatch.ts serve` (bun directly, no shell) — the same
foreground server `dispatch.ts ui` starts on demand. Points worth remembering when changing it:

- It resolves `bun` to an **absolute path** at install time; launchd and systemd start with a
  minimal `PATH`, so a bare `bun` would fail with a confusing log.
- Host/port/state-dir are baked into the generated unit, and `adopt_installed_settings` reads
  them back so `status`/`logs`/`restart`/`uninstall` describe the installed service.
- It binds `127.0.0.1` by default, unlike `ui` (which binds `0.0.0.0` for LAN access).
- The plist/unit spares job processes on restart (see Invariants); `install` rewrites outdated units.
- `dispatch.ts ui` will stop and restart a running server when it detects newer sources — with
  the service installed, use `service.ts restart` instead so the supervisor stays in charge.

## Cross-harness note

The skill is written to be readable by agents other than Claude Code (opencode, pi, and similar
load `SKILL.md` directly). It therefore probes for *capabilities* — "does this session have a
background-capable Bash and a Monitor tool?" — rather than branching on a harness name, and it
never depends on Claude-Code-only machinery such as `${CLAUDE_PLUGIN_ROOT}` or frontmatter hooks.
Keep new instructions harness-neutral and state the fallback explicitly.

## Service restart after every change

Do not restart the service from the working tree. After a change is committed and tested, the deploy
(`bun scripts/deploy.ts`, run by the watchdog once the pushed commit's GitHub checks are green) restarts it. Confirm `/api/build`
reports the deployed sha before reporting the task done.
