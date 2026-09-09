# orch-skill — Repo Notes

A single-skill Claude Code plugin. The skill itself lives at `skills/orch/`; everything at the
repo root is packaging (install + optional service + docs).

## Layout

```
.claude-plugin/marketplace.json   plugin manifest — marketplace `orch-skill`, plugin `orch`
install.sh / uninstall.sh         register/unregister this folder with Claude Code
scripts/service.sh                optional always-on dashboard service (launchd / systemd --user)
skills/orch/
  SKILL.md                        the agent-facing instructions — the actual product
  scripts/dispatch.sh             the CLI; every state mutation goes through it
  scripts/lib/{config,adapters,runs,serve}.sh   sourced by dispatch.sh, never executed
  scripts/dispatch.test.sh        the test suite
  scripts/typecheck.sh            bun bundle + tsc, dependency-free
  server/                         Bun HTTP server for the dashboard
  dashboard/                      the browser client (no framework, no build step)
  shared/types/                   types shared by server and dashboard — must stay Bun-free
  references/                     adapter contract + state/config schemas
  templates/profiles.json         seed for ~/.harness-orch/profiles.json
```

`config/` at the repo root is a **gitignored** symlink to the live state directory
(`${HARNESS_ORCH_HOME:-~/.harness-orch}`) — a convenience for reading `profiles.json`,
`memory.json`, `runs/` and `jobs/` while working in the checkout. It points at an absolute
per-machine path, so it must never be committed; `install.sh` creates it and `.gitignore` blocks
it. Reading through it is fine; writing to `runs/` or `jobs/` through it is not (see Invariants).

Adding a skill would mean appending it to `plugins[0].skills` in
`.claude-plugin/marketplace.json` — a skill on disk that is missing from the manifest is not
loaded.

## Invariants

**`dispatch.sh` owns every mutation.** The dashboard reads `~/.harness-orch` live and assumes the
files are only ever written through a subcommand. Never hand-edit `runs/<id>/state.json`,
`jobs/<id>/*`, `profiles.json` or `memory.json` from a script or a test, and never add a code
path that writes them directly — add or extend a subcommand instead. Callers (including SKILL.md)
must not re-implement what the script already does.

**Sourcing is side-effect free.** `dispatch.sh` defines functions when sourced and only runs
`main` when executed directly (`BASH_SOURCE[0] == $0`). Backgrounded `start` jobs depend on this:
they re-source the same file by its resolved real path in a fresh `bash -c`. Anything added at
file scope that *does* something breaks them.

**Nothing is deleted with `rm`.** `prune`, `service.sh uninstall` and `uninstall.sh` all go
through `trash` when available and otherwise move the target under `<state-dir>/.trash/<stamp>/`.
The `serve/pid` marker is *truncated*, never removed.

**No dependencies.** No `package.json`, no `node_modules`. The server and dashboard run from
source under Bun; `typecheck.sh` borrows `bun-types` and `@types/node` out of Bun's global
install cache into a gitignored `.types/` symlink farm. Do not introduce a package manager.

**Secrets never land in state.** `profiles.json` holds env-var *names* and `${VAR}` references;
interpolation happens at spawn time. `profile show` prints `env` as written. Keep it that way.

**Auth is peer-based, not bind-based.** `route.ts:authorized` lets any loopback peer through
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

The dashboard server bundles `dashboard/` once at startup and keeps it in memory — a running
server never re-reads `server/`, `dashboard/` or `shared/`. So **any** change under `skills/orch/`
is invisible until the process restarts.

**Once the tests and typecheck pass, restart the service. Treat it as the last step of the task,
not an optional follow-up:**

```bash
bash skills/orch/scripts/dispatch.test.sh   # must be 0 failed
bash skills/orch/scripts/typecheck.sh       # must print `typecheck: ok`
bash scripts/service.sh restart             # pick up the change
bash scripts/service.sh status              # confirm: state = running, listener answering
```

Do not use `dispatch.sh ui` to do this when the service is installed. `ui` notices the newer
sources, stops the server and starts its own copy with `nohup` — which the supervisor then races
by restarting its own. `service.sh restart` keeps one owner of the port.

If `service.sh status` reports the unit is not installed, there is nothing to restart and the
next `ui` picks the change up on its own.

## Tests

```bash
bash skills/orch/scripts/dispatch.test.sh
bash skills/orch/scripts/typecheck.sh
```

The suite runs against a temporary `HARNESS_ORCH_HOME`, so it never touches your real state.
`typecheck.sh` exits 0 with a `SKIP:` line when `bun` or `tsc` is absent — a skip is not a pass,
so read the output rather than only the exit code.

## The optional service

`scripts/service.sh` generates a supervisor unit that runs `dispatch.sh serve` — the same
foreground server `dispatch.sh ui` starts on demand. Points worth remembering when changing it:

- It resolves `bun` to an **absolute path** at install time; launchd and systemd start with a
  minimal `PATH`, so a bare `bun` would fail with a confusing log.
- Host/port/state-dir are baked into the generated unit, and `adopt_installed_settings` reads
  them back so `status`/`logs`/`restart`/`uninstall` describe the installed service.
- It binds `127.0.0.1` by default, unlike `ui` (which binds `0.0.0.0` for LAN access).
- `dispatch.sh ui` will stop and restart a running server when it detects newer sources — with
  the service installed, use `service.sh restart` instead so the supervisor stays in charge.

## Cross-harness note

The skill is written to be readable by agents other than Claude Code (opencode, pi, and similar
load `SKILL.md` directly). It therefore probes for *capabilities* — "does this session have a
background-capable Bash and a Monitor tool?" — rather than branching on a harness name, and it
never depends on Claude-Code-only machinery such as `${CLAUDE_PLUGIN_ROOT}` or frontmatter hooks.
Keep new instructions harness-neutral and state the fallback explicitly.
