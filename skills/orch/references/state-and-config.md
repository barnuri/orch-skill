# State and Config Reference

Everything lives under `${HARNESS_ORCH_HOME:-~/.harness-orch}`:

```
profiles.json          settings + named profiles (from templates/profiles.json on first use)
serve.json             dashboard bind address, port and auth policy (from templates/serve.json on first use)
memory.json            learnings log — [] on first use
runs/<run-id>/state.json
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
  "settings": { "default_profile": "claude-sub", "retention_days": 7, "budget_threshold": 85 },
  "profiles": {
    "claude-hub": {
      "harness": "claude",
      "model": "sonnet",
      "flags": ["--dangerously-skip-permissions"],
      "env": { "ANTHROPIC_BASE_URL": "${LLM_HUB_URL}", "ANTHROPIC_AUTH_TOKEN": "${LLM_HUB_KEY}" },
      "auth": ["LLM_HUB_URL", "LLM_HUB_KEY"]
    }
  }
}
```

| Field | Meaning |
|---|---|
| `harness` | adapter name: `claude`, `cursor-agent`, `opencode`, `local-llm` |
| `model` | passed as `--model` (claude, cursor-agent), `-m` (opencode) or `LLM_HUB_MODEL` (local-llm); empty = CLI default |
| `flags` | appended verbatim after the model flag |
| `env` | exported at spawn time. A value that is exactly `${NAME}` is replaced by the caller's environment variable; anything else is a literal. Partial interpolation is unsupported on purpose. |
| `auth` | env-var **names** that must be non-empty before the profile may run. Values are never stored. |
| `settings.default_profile` | the `*` in `profile list`; what SKILL.md uses for a plain `claude` classification |
| `settings.retention_days` | auto-prune cutoff at `run start`; `0` disables |
| `settings.budget_threshold` | `budget-check` trip point (%); env `HARNESS_ORCH_BUDGET_THRESHOLD` overrides |

Errors: unknown profile → exit 2 listing the available names; bad harness → exit 2; unset env
reference → exit 1 `profile <p>: env <KEY> references unset ${NAME}`; missing auth →
exit 1 `profile <p>: required auth env var <NAME> is not set`. `profile show` prints `env` as
written — resolved secrets are never printed.

## memory.json

Flat array, appended by `memory add`, listed newest-first by `memory list`:

```json
{ "ts": "2026-09-02T18:00:00Z", "task_kind": "implement", "profile": "claude-hub",
  "harness": "claude", "model": "sonnet", "outcome": "success", "note": "fast, clean diff" }
```

`outcome` ∈ `success | failure | partial`. `harness`/`model` are copied from the profile at add time.

## runs/<run-id>/state.json

```json
{ "run_id": "20260902-193000-a1b2", "title": "…", "harness_session": "<agent_session_id>",
  "started": "ISO", "finished": null, "status": "running",
  "nodes": [ { "id": "n1", "label": "…", "status": "waiting", "profile": "claude-hub",
               "adapter": null, "job_id": null, "started": null, "finished": null,
               "error": null, "log_tail": [] } ],
  "edges": [ ["n1", "n2"] ] }
```

- Run `status`: `running` until `run finish` sets `done` or `error`. `run sync` never finishes a
  run — the coordinator decides when it is complete.
- Node `status`: `waiting | running | done | error | skipped`. `started` is stamped on the first
  `running`, `finished` on any terminal status. `log_tail` = last 20 log lines, refreshed by
  `run sync`.
- `edges` are `[from, to]` pairs from `node add --after`. A node is *ready* when it is `waiting`
  and every incoming edge's source is `done`.
- Run ids: `YYYYMMDD-HHMMSS-<4 hex>` or `--id` matching `^[A-Za-z0-9._-]+$`.

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
| `/api/profiles` | GET, PUT | envelope adds `harnesses`, `issues`, `limits`; PUT validates before writing |
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
dispatch.sh node update <run-id> <node-id> <status> [--job J] [--error "msg"]
dispatch.sh run sync <run-id>
dispatch.sh run finish <run-id> [--status done|error]
dispatch.sh run list

dispatch.sh serve [--host H] [--port P] | serve --stop
dispatch.sh serve config show | serve config get <key> | serve config set [--host H] [--port P] [--require-token|--no-require-token] [--allow-remote|--no-allow-remote]
dispatch.sh ui [--stop]
dispatch.sh prune [--older-than <N>d|<N>h|<N>] [--dry-run]
```

`run` is overloaded: `run start|finish|list|sync` is run-state; any other second word is the v1
`run <adapter|--profile>` foreground dispatch. Adapter names never collide with those four words.

Exit codes: `0` ok · `1` environment/request failure · `2` bad arguments or unknown id ·
`124` `wait` timed out · `127` required binary missing.
