# State and Config Reference

Everything lives under `${HARNESS_ORCH_HOME:-~/.harness-orch}`:

```
profiles.json          settings + named profiles (from templates/profiles.json on first use)
serve.json             dashboard bind address, port and auth policy (from templates/serve.json on first use)
cli.json               global CLI command name and bin dir (written by install.sh; default name: orch)
memory.json            learnings log — [] on first use
runs/<run-id>/state.json
runs/<run-id>/prompts/<node-id>.md   stored task prompts written by `plan apply`
runs/<run-id>/messages.jsonl         the run's mailbox (`msg send|read`)
jobs/<job-id>/{adapter,profile,pid,log,exit_code}
serve.token            bearer token for the dashboard, 0600, minted on first `serve`/`ui`
serve/host             bind host of the running server
serve/port             its port
serve/pid              its pid — truncated (never deleted) on a clean stop
serve/log              stdout+stderr of a backgrounded server, 0600
.trash/<utc-stamp>/    prune fallback when `trash` is not on PATH
```

## profiles.json

```json
{
  "settings": {
    "default_profile": "copilot-default",
    "disabled_harnesses": ["claude", "local-llm", "opencode"],
    "max_parallel": 4,
    "max_attempts": 5,
    "max_nodes": 12,
    "planner_profile": "copilot-planner",
    "retention_days": 7,
    "budget_threshold": 85,
    "learning": {
      "auto_record_memory": true,
      "auto_scan_on_finish": true,
      "auto_apply_safe": false,
      "min_samples": 3,
      "recency_days": 30,
      "dismiss_ttl_days": 30
    }
  },
  "models": {
    "claude-sonnet": {
      "slug": "sonnet",
      "harnesses": ["claude"],
      "description": "Default workhorse",
      "cost": "subscription",
      "quality": "standard",
      "speed": "balanced"
    }
  },
  "profiles": {
    "claude-llm-hub": {
      "harness": "claude",
      "model": "claude-sonnet",
      "flags": ["--dangerously-skip-permissions"],
      "env": { "ANTHROPIC_BASE_URL": "${LLM_HUB_URL}", "ANTHROPIC_AUTH_TOKEN": "${LLM_HUB_KEY}" },
      "auth": ["LLM_HUB_URL", "LLM_HUB_KEY"]
    }
  }
}
```

| Field | Meaning |
|---|---|
| `models` | catalog of callable models (`slug` → CLI); referenced by id from profiles |
| `models.<id>.slug` | value passed to the harness (`--model`, `-m`, or `LLM_HUB_MODEL`) |
| `harness` | adapter name: `claude`, `cursor-agent`, `opencode`, `local-llm`, `copilot` |
| `model` | catalog **id** (not raw slug); resolved to `models[id].slug` at spawn |
| `allowed_models` | whitelist of catalog ids and/or slug prefix patterns (`llama_swap*`); omitted = all models for this profile's harness |
| `description`, `cost`, `quality`, `speed`, `risk`, `tags`, `strengths`, `avoid_for`, … | routing metadata for `profile pick` and the dashboard |
| `flags` | appended verbatim after the model flag |
| `env` | exported at spawn time. A value that is exactly `${NAME}` is replaced by the caller's environment variable; anything else is a literal. Partial interpolation is unsupported on purpose. |
| `auth` | env-var **names** that must be non-empty before the profile may run. Values are never stored. |
| `settings.default_profile` | the `*` in `profile list`; what SKILL.md uses for a plain `claude` classification |
| `settings.disabled_harnesses` | harness ids hidden in the dashboard profile picker and skipped by `profile pick` (adapters remain in code). Template: `claude`, `local-llm`, `opencode` |
| `settings.max_parallel` | nodes `run advance` keeps running at once (1–64; template 4) |
| `settings.max_attempts` | total dispatch tries before automatic retry stops (template 5; `1` disables automatic retry; `-1` allows unlimited retries) |
| `settings.max_nodes` | most tasks `plan apply` accepts from one plan (1–200; template 12) |
| `settings.planner_profile` | profile `orch plan` dispatches the planner on (template `copilot-planner`) |
| `settings.retention_days` | auto-prune cutoff at `run start`; `0` disables |
| `settings.budget_threshold` | `budget-check` trip point (%); env `HARNESS_ORCH_BUDGET_THRESHOLD` overrides |

Errors: unknown profile → exit 2 listing the available names; bad harness → exit 2; unset env
reference → exit 1 `profile <p>: env <KEY> references unset ${NAME}`; missing auth →
exit 1 `profile <p>: required auth env var <NAME> is not set`. `profile show` prints `env` as
written — resolved secrets are never printed.

## memory.json

Flat array, appended by `memory add`, listed newest-first by `memory list`:

```json
{ "ts": "2026-09-02T18:00:00Z", "task_kind": "implement", "profile": "claude-llm-hub",
  "harness": "claude", "model": "sonnet", "outcome": "success", "note": "fast, clean diff" }
```

`outcome` ∈ `success | failure | partial`. `harness`/`model`/`model_id` are copied from the profile at add time.

## suggestions.json

```json
{ "generated_at": "2026-09-09T08:00:00Z", "suggestions": [ … ] }
```

Pending suggestions expire to `expired` after `settings.learning.dismiss_ttl_days` (default 30).
Mutate via `orch suggest scan|list|apply|dismiss` or `#/suggestions` in the dashboard.

## runs/<run-id>/state.json

```json
{ "run_id": "20260902-193000-a1b2", "title": "…", "harness_session": "<agent_session_id>",
  "started": "ISO", "finished": null, "status": "running",
  "nodes": [ { "id": "n1", "label": "…", "status": "waiting", "profile": "claude-llm-hub",
               "adapter": null, "job_id": null, "started": null, "finished": null,
               "model": "claude-sonnet", "model_id": "claude-sonnet",
               "error": null, "log_tail": [], "prompt": "@/path/prompt.md",
               "dispatch_args": [], "attempts": [], "next_retry_at": null } ],
  "edges": [ ["n1", "n2"] ] }
```

- Run `status`: `running` until `run finish` sets `done` or `error`. `run sync` never finishes a
  run — the coordinator decides when it is complete.
- Node `status`: `waiting | running | done | error | skipped`. `started` is stamped on the first
  `running`, `finished` on any terminal status. `log_tail` = last 20 log lines, refreshed by
  `run sync`.
- `prompt` stores the inline prompt or `@file` reference from the last dispatch; `dispatch_args`
  stores only args that followed the prompt. Older runs may omit both.
- `model` stores the resolved model slug passed to the harness and `model_id` stores the catalog
  id when the node was dispatched through a profile. Direct adapter dispatches may leave both null.
- `attempts` archives each retry source attempt:
  `{job_id,error,finished,log_tail,profile,adapter,model,model_id,cost,session,reason,retry_mode,retry_session}`.
  `retry_mode` is `resumed` when the next launch continued the prior harness session, `restarted`
  when it resent the original task to a fresh/different session, and `null` for `--no-dispatch`.
  Older runs may omit it.
- `next_retry_at` is the earliest automatic retry time for an errored node. Backoff starts at the
  `run advance --interval` value (or the default interval for `run sync`) and doubles per archived
  attempt, capped at 5 minutes. Manual `node retry` / `run retry` ignore this delay.
- `edges` are `[from, to]` pairs from `node add --after`. A node is *ready* when it is `waiting`
  and every incoming edge's source is `done`.
- `node retry` and `run retry` reopen a finished run, reset failed nodes to `waiting`, archive
  their current fields into `attempts`, and redispatch unless `--no-dispatch` is set. Same-harness
  retries resume a recorded harness session when the adapter supports it. Manual retries are not
  blocked by `settings.max_attempts`; automatic retries are. Fallback/different
  harness retries restart from `prompt` with a note about partial work. `run sync`/`run advance`
  do the same automatically while attempts remain and backoff has elapsed.
- Run ids: `YYYYMMDD-HHMMSS-<4 hex>` or `--id` matching `^[A-Za-z0-9._-]+$`.
- `plan` (planned runs only): `{node, profile, applied, summary, tasks}` — the planner node id,
  its profile, when `plan apply` added the tasks (`null` while the planner works), the plan's
  summary line and task count.

## serve.json

```json
{ "host": "0.0.0.0", "port": 6724, "require_token": false, "allow_remote": false }
```

| Field | Meaning |
|---|---|
| `host` | bind address for `orch serve`, `orch ui` and the optional background service |
| `port` | TCP port (default 6724) |
| `require_token` | when `true`, loopback peers must present the bearer token too |
| `allow_remote` | when `true`, non-loopback peers need no bearer token |

`orch serve config show|get|set` reads and writes this file. `service.sh install` updates it;
`service.sh restart` (or `orch serve --stop` then `orch serve`) picks up edits. CLI
`--host`/`--port` on `orch serve` override for one shot only.

## Serve API

The dashboard is a Bun server (`orch serve` / `orch ui`, configured via `serve.json`) reading the
files above directly — there is no generated data to keep in sync. Everything under `/api/`
requires `Authorization: Bearer <serve.token>`; the `?token=` in the URL only unlocks the page,
which then sends the header. A `Host` header naming neither the bind address, the machine's
hostname nor `localhost` is refused with 400.

| Route | Methods | Notes |
|---|---|---|
| `/` | GET | the dashboard shell + its bundled chunks |
| `/api/health` | GET | `{ok, pid, home, version}` |
| `/api/runs` | GET | `{generated_at, runs:[summary…]}` with `counts: {waiting, running, done, error, skipped}` |
| `/api/runs/:id` | GET | `{generated_at, run:<state.json>}`; 404 for an id outside `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `/api/runs/:id/retry` | POST | dispatches `run retry <id>` |
| `/api/runs/:id/nodes/:node/retry` | POST | dispatches `node retry <id> <node>` |
| `/api/profiles` | GET, PUT | envelope adds `harnesses`, `issues`, `limits`; PUT validates before writing |
| `/api/harnesses` | GET | live probe per adapter (`dispatch.sh harness list --json`); `enabled` reflects `settings.disabled_harnesses` |
| `/api/memory` | GET, PUT | same shape with `outcomes` |

Every GET carries a strong `ETag` over the payload only (never `generated_at`), so the 2 s poll
answers 304 while nothing changes. A PUT sends `If-Match`; a stale one is refused with 412 and
the current etag, which is what stops the dashboard from clobbering a CLI write. Bodies are
capped at 4 MiB (413) and must be `application/json` (415).

## Subcommand grammar

```
dispatch.sh init
dispatch.sh profile list | show <name>
dispatch.sh memory add --profile P --outcome success|failure|partial [--kind K] [--note "…"]
dispatch.sh memory list [--profile P] [-n N]

dispatch.sh classify "<task>" [--complexity trivial|small|medium|large] [--prefer-local]
dispatch.sh budget-check

dispatch.sh run   (--profile <name> | <adapter>) <prompt|@file> [pass-through args…]
dispatch.sh start (--profile <name> | <adapter>) <prompt|@file> [pass-through args…]
dispatch.sh status <job-id> | tail <job-id> [-n N] | wait <job-id> [--timeout S] [--interval S] | list

dispatch.sh run start "<title>" [--id <run-id>]
dispatch.sh node add <run-id> <node-id> "<label>" [--after a,b] [--profile P]
dispatch.sh node dispatch <run-id> <node-id> [--profile <name> | <adapter>] <prompt|@file> [args…]
dispatch.sh node retry <run-id> <node-id> [--profile P | <adapter>] [--no-dispatch] [<prompt|@file>]
dispatch.sh node update <run-id> <node-id> <status> [--job J] [--error "msg"]
dispatch.sh run sync <run-id>
dispatch.sh plan <run-id> "<goal>|@file" [--profile P] [--node ID]
dispatch.sh plan apply <run-id> [--file plan.json]
dispatch.sh run advance <run-id> [--until-done] [--interval SECS] [--timeout SECS] [--no-finish]
dispatch.sh run retry <run-id> [--profile P] [--no-dispatch]
dispatch.sh msg send <run-id> --to orch|all|<node-id> [--from <node-id>|orch] "<text>"
dispatch.sh msg read <run-id> [--for orch|<node-id>] [--since N] [--all]
dispatch.sh run finish <run-id> [--status done|error]
dispatch.sh run list

dispatch.sh serve [--host H] [--port P] | serve --stop
dispatch.sh serve status [--json]
dispatch.sh serve recover [--start|--no-start]
dispatch.sh serve config show | serve config get <key> | serve config set [--host H] [--port P] [--require-token|--no-require-token] [--allow-remote|--no-allow-remote]
dispatch.sh ui [--stop]
dispatch.sh sync [--no-serve]
dispatch.sh prune [--older-than <N>d|<N>h|<N>] [--dry-run]
```

`run` is overloaded: `run start|finish|list|sync|advance` is run-state; any other second word is the v1
`run <adapter|--profile>` foreground dispatch. Adapter names never collide with those five words.

Exit codes: `0` ok · `1` environment/request failure · `2` bad arguments or unknown id ·
`124` `wait` timed out · `127` required binary missing.
