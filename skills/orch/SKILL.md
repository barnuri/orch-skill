---
name: orch
description: >
  orch — orchestrate work across harnesses: route each task to a named profile (Claude Code on
  its own subscription or through an OpenAI-compatible gateway, Cursor's cursor-agent, opencode,
  a local model) by complexity, budget and remembered preferences; run multi-node DAGs in the
  background; watch them on a live dashboard. Use when asked to offload, farm out, split up, or
  route work to other agents/models, or to run something "on cursor" / "on the local model" /
  "with the hub profile". Triggers: "orchestrate this", "dispatch to", "run this on cursor",
  "offload to local llm", "use the cheap profile".
allowed-tools: Bash(bash *), Monitor, TaskOutput, Read, AskUserQuestion
---

# orch

The agent running this skill is the coordinator. It decides *what* runs *where*, records every
state change with one short script call, and reports results. The dispatched harnesses do the work.

All mechanics live in `<skill-dir>/scripts/dispatch.sh` (`<skill-dir>` is this skill's base
directory, stated by the harness when it loads the skill). Below, `orch <sub>` is shorthand for
`bash <skill-dir>/scripts/dispatch.sh <sub>`. Never re-implement what the script does, and never
hand-edit the files it owns — every mutation goes through a subcommand so the dashboard stays true.

Everything user-facing lives in `~/.harness-orch/` (override with `HARNESS_ORCH_HOME`):
`profiles.json`, `memory.json`, `runs/`, `jobs/`, `serve.token`, `serve/`. Schemas and the full
subcommand grammar: [state-and-config.md](references/state-and-config.md).

## Step 0 — Bootstrap (once per machine, idempotent)

```bash
orch init            # creates ~/.harness-orch with template profiles.json and an empty memory.json
orch profile list    # name, harness, model — `*` marks settings.default_profile
orch memory list -n 20
```

`init` never overwrites a profiles.json the user has edited. If `profile list` shows a profile
whose `auth` env var is missing on this machine, say so — do not try to supply credentials.
`profiles.json` holds env-var **names** and `${VAR}` references only; never write a secret value
into it.

## Step 1 — Choose a profile

Precedence, highest first:

1. **The user named a target** ("send this to cursor", "use claude-hub") → that profile or adapter.
2. **Memory hint** — a `memory list` row whose `task_kind`/note matches this kind of task and
   whose outcome was `success` → its profile. Failures count against a profile for that kind.
3. **Classifier** — `orch classify "<task>" [--complexity trivial|small|medium|large] [--prefer-local]`
   prints one adapter; map it to a profile:

| classify prints | Use |
|---|---|
| `claude-native` | do the work in this session — Step 2 |
| `claude` | `settings.default_profile` (template: `claude-sub`), or `claude-hub` when the user wants the cheaper route |
| `cursor-agent` | `cursor-default` |
| `opencode` | `opencode-default` |
| `local-llm` | `local-qwen` |

The classifier's policy (top rule wins): trivial/small **and** `budget-check` passes →
`claude-native`; `budget-check` fails (this Claude session near its subscription limit) → first
available of `cursor-agent` → `opencode` → `local-llm` → `claude-native` with a warning;
`--prefer-local` or medium with `LLM_HUB_URL` set → `local-llm`; otherwise `claude-native`.
`orch budget-check` is callable alone (exit 0 safe / 1 avoid); a missing, stale or
non-subscription snapshot always counts as safe.

If the choice materially changes cost or risk and none of the three sources settles it, ask —
`AskUserQuestion` when the options are discrete, plain text otherwise (or where that tool doesn't
exist). Dispatching to a paid CLI is not free to undo.

## Step 2 — `claude-native` means "here"

If the target is `claude-native`, stop and do the work directly in this session — nothing to
spawn. Inside a run (Step 4) still record it: `node update <run> <node> running`, then `done`.

## Step 3 — Probe capability, then pick the tier

Decide by **which tools exist in this session, never by harness name**:

> If this session's tool list includes a `Bash` tool that accepts `run_in_background` **and** a
> `Monitor` tool → **Native Tier**. Otherwise — opencode, pi, or a Claude session without those
> tools — **Fallback Tier**.

Targets are written `(--profile <name> | <adapter>)`; prompts may be inline or `@/path/to/file`;
anything after the prompt passes through verbatim to the underlying CLI.

### Single task

**Native Tier**
1. `Bash(run_in_background: true)`: `orch run --profile <name> "<prompt>"` — the harness owns
   the backgrounding, so the script runs synchronously and streams.
2. Attach `Monitor` to the returned task; filter for progress **and** failure signatures.
3. On completion read the output (`TaskOutput`); the exit code is the harness's own.

**Fallback Tier**
1. `orch start --profile <name> "<prompt>"` → prints a job-id (self-backgrounds via `nohup`).
2. `orch status <job-id>` across turns, or block once: `orch wait <job-id> --timeout 300`
   (exit 124 = still running).
3. `orch tail <job-id> [-n N]` for the output. `orch list` shows every job with its profile.

### Multi-node run (a DAG of tasks)

Emit one command per state change; the dashboard reads `state.json` live, so it is current the
moment a command returns — nothing to re-render. Shell state does
not survive between tool calls, so `run start` prints the run id — copy that literal `<run-id>`
into every following command (and hand the user its dashboard link, `#/run/<run-id>`).

```bash
orch run start "<title>"                                   # prints <run-id>; auto-prunes old runs first
orch node add <run-id> plan   "Plan the change"
orch node add <run-id> impl   "Implement"    --after plan --profile claude-hub
orch node add <run-id> tests  "Write tests"  --after plan --profile local-qwen
orch node add <run-id> review "Review + fix" --after impl,tests --profile cursor-default
orch run sync <run-id>                     # prints id<TAB>status per node, then "ready: plan", "running: 0"
```

Loop until every node is terminal:
1. For each id in `ready:` — `orch node dispatch <run-id> <node-id> "<prompt>"` (uses the node's
   own `--profile`; pass `--profile P` or an adapter to override). It starts the job and marks
   the node `running`. A `claude-native` node is done inline (Step 2) with `node update` instead.
2. Native Tier: `Monitor` the dispatched jobs' logs if useful; Fallback Tier: nothing to attach.
3. `orch run sync <run-id>` — flips finished jobs to `done`/`error` (with `exit N` and the last
   20 log lines), prints the next `ready:` set. Poll with `run sync`, not by reading files.
4. Skip a node the plan no longer needs: `orch node update <run-id> <node-id> skipped`.

Finish and learn:

```bash
orch run finish <run-id>                    # error if any node errored, else done
orch memory add --profile claude-hub --outcome success --kind "implement" --note "fast, clean diff"
```

Add one memory row per profile actually used, honest about the outcome — this is what Step 1
reads next time.

## Dashboard

`orch ui` brings up a Bun server on `0.0.0.0:6724` and opens it. One server serves every session
on the machine: if it is already up, `ui` reuses it and just prints the URL; if the skill's
sources are newer than the running process, it restarts it first. `ORCH_NO_OPEN=1` prints the URL
instead of opening a browser (headless or remote shells); `orch ui --stop` shuts the server down.
`orch serve [--host H] [--port P]` runs the same server in the foreground. Both need **bun 1.3+**
— set `ORCH_BUN` to point at a specific binary; a missing bun exits 127.

The main view lists every run, active first; `#/run/<run-id>` shows one run's graph — running
nodes pulse, click a node for profile, job, timings, error and log tail. `#/profiles` and
`#/memory` edit the two JSON files in place, with the same validation the CLI applies and an
ETag check that refuses to overwrite a change made behind your back. The page polls every 2 s and
shows "updated Ns ago". Give the user the `#/run/<run-id>` link when a run starts.

**Requests from this machine need no token** — the server authorizes any loopback peer, so `ui`
prints a plain `http://127.0.0.1:<port>/` and the page never asks for anything. A request from
any other address still needs the bearer token, which is what the hostname URL carries and what
`~/.harness-orch/serve.token` holds (minted 0600 on first start). Trash that file and restart to
rotate it. `ORCH_REQUIRE_TOKEN=1` demands the token from loopback too.

## Retention

`orch prune [--older-than 7d|12h|3] [--dry-run]` recoverably removes finished runs and their jobs
(via `trash`, else a move under `~/.harness-orch/.trash/<stamp>/` — never `rm`). It also
runs automatically at every `run start` using `settings.retention_days` (template: 7; `0`
disables). Running runs and jobs are never touched.

## Adapters

| Adapter | Needs | Invocation |
|---|---|---|
| `claude-native` | nothing — sentinel, Step 2 | — |
| `claude` | `claude` on `PATH` | `claude -p … --output-format text [--model M] [flags]` |
| `cursor-agent` | `cursor-agent` on `PATH` | `cursor-agent -p … --output-format text --force [--model M]` |
| `opencode` | `opencode` on `PATH` | `opencode run … --auto [-m M]` |
| `local-llm` | `LLM_HUB_URL` (OpenAI-compatible base); optional `LLM_HUB_MODEL`, `LLM_HUB_TIMEOUT` | POST `/chat/completions` |

A profile supplies the model, CLI flags and env for its harness (e.g. `claude-hub` points
`ANTHROPIC_BASE_URL` at `${LLM_HUB_URL}`). A missing binary or unset variable fails fast with a
clear message (exit 127 / 1) — report it, do not retry. Contract and how to add one:
[adapter-contract.md](references/adapter-contract.md).

## Security

The dashboard speaks **plain HTTP** and binds `0.0.0.0` by default — a deliberate trade for a
personal LAN tool, and the thing to understand before running it anywhere else: the bearer token
travels in clear on the local network. Anyone who can reach port 6724 *and* holds the token can
read job logs and rewrite `profiles.json`. On a shared or untrusted network run `orch serve
--host 127.0.0.1`, which the optional background service uses by default. Never expose the port
beyond the LAN, and never put a secret **value** in `profiles.json` — only env-var names and
`${VAR}` references.

Loopback requests skip auth entirely, on the reasoning that anyone who can open a socket from
this machine could already read the token file. The exception is a **shared multi-user host**,
where another local account can reach 127.0.0.1: set `ORCH_REQUIRE_TOKEN=1` there so the token
is demanded from every peer.

If a `~/.harness-orch/index.html` or `data/` directory is still around, it is a leftover from the
retired `file://` dashboard; `orch init` points it out and you can trash it.
