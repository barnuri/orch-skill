# orch

An agent skill that routes work across the coding agents you already have installed — Claude
Code, Cursor's `cursor-agent`, opencode, or any OpenAI-compatible endpoint — runs multi-step
task graphs in the background, and shows them on a live dashboard.

You keep talking to one agent. It decides which harness should do each piece of work, dispatches
it, tracks it, and remembers which profile handled that kind of task well last time.

```
you ──▶ your agent ──┬──▶ claude       (subscription, or via a gateway)
                     ├──▶ cursor-agent
                     ├──▶ opencode
                     └──▶ local model  (OpenAI-compatible)
                              │
                              ▼
                     live dashboard on :6724
```

## Requirements

| Needed for | Requirement |
|---|---|
| Everything | `bash` + coreutils |
| Installing the skill | the [`claude` CLI](https://docs.claude.com/en/docs/claude-code) |
| The dashboard | [Bun](https://bun.sh) 1.3+ (`ORCH_BUN` overrides the binary) |
| `local-llm` adapter, budget check | `curl` and `jq` |
| Recoverable deletes | `trash` (optional — falls back to a timestamped move) |
| Each adapter | that harness's own CLI on `PATH` (`claude`, `cursor-agent`, `opencode`) |

Nothing is installed into your project and there is no `node_modules` — the server and dashboard
run straight off the TypeScript sources under Bun.

## Install

```bash
git clone https://github.com/barnuri/orch-skill.git
cd orch-skill
./install.sh
```

That registers this folder with Claude Code as a local directory-source plugin marketplace and
installs the `orch` plugin from it. Re-run `./install.sh` any time — it is idempotent, and after
a `git pull` it is also how you upgrade (a directory marketplace is read live from this folder).

Want the dashboard running permanently too? `./install.sh --with-service`.

Then restart Claude Code and bootstrap the state directory once:

```bash
bash skills/orch/scripts/dispatch.sh init
```

Removing it: `./uninstall.sh` (add `--with-service` and/or `--purge-state`).

## Using it

Talk to your agent normally. It reaches for orch when you say things like:

- "orchestrate this across a few agents"
- "run this one on cursor"
- "offload the tests to the local model"
- "use the cheap profile for this"

Underneath, everything is one script — usable on its own, without an agent:

```bash
orch() { bash skills/orch/scripts/dispatch.sh "$@"; }

orch profile list                              # what's configured, * = default
orch classify "rename a variable"              # -> which adapter should take this

# one task, backgrounded
job=$(orch start --profile cursor-default "summarise src/parser.ts")
orch status "$job"                             # running | done exit=0
orch tail "$job" -n 40

# a graph of tasks
run=$(orch run start "Add pagination")
orch node add "$run" plan   "Plan the change"
orch node add "$run" impl   "Implement"   --after plan  --profile claude-sub
orch node add "$run" tests  "Write tests" --after plan  --profile local-qwen
orch node add "$run" review "Review"      --after impl,tests --profile cursor-default
orch run sync "$run"                           # per-node status + which nodes are ready now
orch node dispatch "$run" plan "Plan the change in detail"
orch run finish "$run"

# record what worked, so the next run picks better
orch memory add --profile cursor-default --outcome success --kind review --note "caught 2 real bugs"
```

`orch -h` prints the full subcommand grammar.

## Dashboard

```bash
bash skills/orch/scripts/dispatch.sh ui
```

Starts (or reuses) the Bun server and opens the tokenized URL. Runs are listed newest-first,
`#/run/<run-id>` draws one run's DAG with running nodes pulsing, and `#/profiles` / `#/memory`
edit the two JSON files in place with the same validation the CLI applies. The page polls every
2 s. `ORCH_NO_OPEN=1` prints the URL instead of opening a browser; `ui --stop` shuts it down.

**No token prompt for local use.** The server authorizes any request coming from this machine, so
the local URL is a plain `http://127.0.0.1:6724/` and the page opens straight into the runs list.
A request from any other address still needs the bearer token, read from
`~/.harness-orch/serve.token` (minted `0600` on first start) — that is what the hostname URL
carries when the server is bound to `0.0.0.0`. Trash that file and restart to rotate it.

## Optional: run the dashboard as a background service

By default the server starts on demand and dies with the machine. If you would rather have it
always up:

```bash
bash scripts/service.sh install          # macOS launchd, or Linux systemd --user
bash scripts/service.sh status
bash scripts/service.sh logs -n 50
bash scripts/service.sh restart
bash scripts/service.sh uninstall
```

| | |
|---|---|
| macOS | launchd agent `io.github.barnuri.orch` at `~/Library/LaunchAgents/io.github.barnuri.orch.plist`, `RunAtLoad` + `KeepAlive` |
| Linux | systemd `--user` unit `orch-dashboard.service` under `~/.config/systemd/user/`, `Restart=always` |
| Bind address | **`127.0.0.1` by default.** An always-listening service is a bigger exposure than an on-demand one, so LAN access is opt-in: `install --host 0.0.0.0` |
| Auth | none from this machine; the bearer token from every other peer. `install --require-token` demands it locally too |
| Port | `6724` — change with `install --port N` |
| State dir | `~/.harness-orch`, or `install --home DIR` |
| Log | `<state-dir>/serve/service.log` |
| Bun | resolved to an absolute path at install time, because a supervisor starts with a minimal `PATH` |

Options are baked into the generated unit, so `status`, `logs`, `restart` and `uninstall` read
them back rather than assuming the defaults. On Linux, `loginctl enable-linger $USER` keeps the
service alive while you are logged out.

With the service installed, `dispatch.sh ui` finds the running server and just opens the URL. One
caveat: `ui` restarts the server when it notices the skill's sources changed — after editing
`server/` or `dashboard/`, prefer `scripts/service.sh restart` so the supervisor stays in charge.

## Adapters

| Adapter | Needs | Invocation |
|---|---|---|
| `claude-native` | nothing — a sentinel meaning "the calling agent does this itself" | — |
| `claude` | `claude` on `PATH` | `claude -p … --output-format text [--model M]` |
| `cursor-agent` | `cursor-agent` on `PATH` | `cursor-agent -p … --output-format text --force [--model M]` |
| `opencode` | `opencode` on `PATH` | `opencode run … --auto [-m M]` |
| `local-llm` | `LLM_HUB_URL` (an OpenAI-compatible base URL); optional `LLM_HUB_MODEL`, `LLM_HUB_TIMEOUT` | `POST /chat/completions` |

A missing binary or unset variable fails fast with a clear message (exit 127 / 1) rather than
half-running. Adding an adapter: [`skills/orch/references/adapter-contract.md`](skills/orch/references/adapter-contract.md).

## Profiles and memory

A **profile** is a named bundle of harness + model + CLI flags + env, so a task can be routed by
intent ("the cheap one", "the local one") instead of by remembering flags. Profiles live in
`~/.harness-orch/profiles.json`, seeded from
[`templates/profiles.json`](skills/orch/templates/profiles.json) on first `init` and never
overwritten afterwards.

Profiles hold env-var **names** and `${VAR}` references only — never a secret value. A profile
whose `auth` variables are missing refuses to run and says which one is unset.

**Memory** is a flat append-only log of what actually happened (`profile`, `task_kind`,
`outcome`, `note`). It is the second-highest input to routing, above the classifier: a profile
that succeeded at this kind of task before gets picked again.

### Editing the config from the checkout

`install.sh` leaves a `config` symlink at the repo root pointing at the live state directory, so
the files you actually edit are one hop away:

```bash
ls config/                 # profiles.json  memory.json  runs/  jobs/  serve.token
$EDITOR config/profiles.json
```

It is per-machine and absolute, so it is **gitignored** — never committed. Create it by hand if
you cloned without running `install.sh`:

```bash
ln -sfn "${HARNESS_ORCH_HOME:-$HOME/.harness-orch}" config
```

The dashboard's `#/profiles` and `#/memory` views edit the same two files with validation and an
ETag check, which is the safer route while a run is in flight.

Schemas, exit codes, and the full state layout:
[`skills/orch/references/state-and-config.md`](skills/orch/references/state-and-config.md).

## Retention

```bash
orch prune --older-than 7d --dry-run
```

Finished runs and their jobs are removed recoverably — `trash` when available, otherwise a move
under `~/.harness-orch/.trash/<stamp>/`. Never `rm`. It also runs automatically at every
`run start` using `settings.retention_days` (default 7; `0` disables). Running runs are never
touched.

## Security

The dashboard speaks **plain HTTP**. On the machine's own loopback that is unremarkable; over a
LAN it means the bearer token travels in clear, and anyone who can reach the port *and* holds
the token can read job logs and rewrite `profiles.json`.

- **Loopback requests need no token.** Anyone who can open a socket from this machine could
  already read `serve.token`, so requiring it back would add friction without adding a barrier.
- **On a shared multi-user host, set `ORCH_REQUIRE_TOKEN=1`** (or install the service with
  `--require-token`). That is the one case where the bypass matters: another local account can
  reach `127.0.0.1` and would otherwise get in.
- Every non-loopback peer presents the bearer token, always.
- The background service binds `127.0.0.1` by default. Keep it that way unless you want LAN access.
- `dispatch.sh ui` binds `0.0.0.0` (it was built to be opened from a phone on the same LAN). Use
  `dispatch.sh serve --host 127.0.0.1` when that is not what you want.
- Never expose the port to the internet.
- Never put a secret **value** in `profiles.json` — only env-var names and `${VAR}` references.

## Development

Tests and typechecking, no install step required:

```bash
bash skills/orch/scripts/dispatch.test.sh    # the full suite
bash skills/orch/scripts/typecheck.sh        # bun bundle + tsc (skips cleanly if either is absent)
```

Repo layout and the invariants to respect when changing things: [CLAUDE.md](CLAUDE.md).

## License

[MIT](LICENSE)
