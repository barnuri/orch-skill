# State and Config Reference

Everything lives under `${HARNESS_ORCH_HOME:-~/.harness-orch}`:

```
profiles.json          settings + named profiles (from templates/profiles.json on first use)
serve.json             dashboard bind address, port and auth policy (from templates/serve.json on first use)
cli.json               global CLI command name and bin dir (written by install.ts; default name: orch)
memory.json            learnings log — [] on first use
feedback/<id>.json     feedback items (`orch feedback`)
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
.*-migrated            one-time profiles.json migration markers (e.g. .bench-local-migrated)
```

## profiles.json

```json
{
  "settings": {
    "default_profile": "claude-default",
    "disabled_harnesses": [],
    "max_parallel": 4,
    "max_attempts": 5,
    "max_nodes": 12,
    "planner_profile": "claude-planner",
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
    "local-qwen3.6-35b": {
      "slug": "llama_swap/qwen3.6-35b",
      "harnesses": ["claude", "copilot", "local-llm", "pi"],
      "behaves_as": "claude-haiku-4-5-20251001",
      "description": "Local default: 15/15 in the 2026-10-04 local-llm benchmark final matrix",
      "cost": "free",
      "quality": "standard",
      "speed": "balanced"
    }
  },
  "profiles": {
    "claude-llm-hub": {
      "harness": "claude",
      "model": "local-qwen3.6-35b",
      "allowed_models": ["llama_swap*"],
      "parallel_ok": false,
      "fallback": "copilot-llm-hub",
      "flags": ["--dangerously-skip-permissions", "--bare", "--strict-mcp-config"],
      "env": {
        "ANTHROPIC_BASE_URL": "${LLM_HUB_URL}",
        "ANTHROPIC_AUTH_TOKEN": "${LLM_HUB_KEY}",
        "ANTHROPIC_MODEL": "${PROFILE_MODEL}",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "${PROFILE_MODEL}",
        "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1"
      },
      "auth": ["LLM_HUB_URL", "LLM_HUB_KEY"]
    }
  }
}
```

| Field | Meaning |
|---|---|
| `models` | catalog of callable models (`slug` → CLI); referenced by id from profiles |
| `models.<id>.slug` | value passed to the harness (`--model`, `-m`, or `LLM_HUB_MODEL`) |
| `harness` | adapter name: `claude`, `cursor-agent`, `opencode`, `local-llm`, `copilot`, `pi` |
| `model` | catalog **id** (not raw slug); resolved to `models[id].slug` at spawn |
| `allowed_models` | whitelist of catalog ids and/or slug prefix patterns (`llama_swap*`); omitted = all models for this profile's harness |
| `description`, `cost`, `quality`, `speed`, `risk`, `tags`, `strengths`, `avoid_for`, … | routing metadata for `profile pick` and the dashboard |
| `flags` | appended verbatim after the model flag |
| `env` | exported at spawn time. A value that is exactly `${NAME}` is replaced by the caller's environment variable; anything else is a literal. Partial interpolation is unsupported on purpose. |
| `auth` | env-var **names** that must be non-empty before the profile may run. Values are never stored. |
| `settings.default_profile` | the `*` in `profile list`; what SKILL.md uses for a plain `claude` classification |
| `settings.disabled_harnesses` | harness ids hidden in the dashboard profile picker and skipped by `profile pick` (adapters remain in code). Template: none |
| `settings.harness_usage` | map harness id to a non-empty array of `"chat"` and/or `"runs"`: where the harness may be used. Missing means both. Set with `dispatch.ts harness set-usage <id> chat\|runs\|both` or the Harnesses page. Template: none |
| `profiles.<name>.usage` | same array for one profile (also `defaults.usage`). Missing means both. A profile is available for a use only when the profile AND its harness allow it and the harness is not in `disabled_harnesses`. Set with `dispatch.ts profile set-usage <name> chat\|runs\|both` or the Profiles page. The committed template stays generic (both); the gitignored overlay may limit personal profiles |
| `settings.max_parallel` | nodes `run advance` keeps running at once (1–64; template 4) |
| `settings.max_attempts` | total dispatch tries before automatic retry stops (template 5; `1` disables automatic retry; `-1` allows unlimited retries) |
| `settings.max_nodes` | most tasks `plan apply` accepts from one plan (1–200; template 12) |
| `settings.planner_profile` | profile `orch plan` dispatches the planner on (template `claude-planner`) |
| `settings.llm_hub` | `{mode: "smart-auto"\|"off", harness, role_tiers: {role: tier}}`, written by `hub setup`/`hub off`. With `smart-auto`, nodes default to `<harness>-smart-auto` and get their tier from their role |
| `settings.retention_days` | auto-prune cutoff at `run start`; `0` disables |
| `settings.budget_threshold` | `budget-check` trip point (%); env `HARNESS_ORCH_BUDGET_THRESHOLD` overrides |
| `settings.auto_kill_ghosts` | `false` (default). `true` lets `sync` kill ghost runners whose home is missing, record is missing or home is a temp test home older than 30 min, after a three-look re-judge. `false` only reports them. See SKILL.md "Ghost loops and runners" |

### Local (llm-hub) profiles

The template ships `claude-llm-hub`, `claude-llm-hub-planner`, `copilot-llm-hub`,
`opencode-llm-hub`, `pi-llm-hub` and `local-llm-fast`, each on a model that passed the 2026-10-04
local-llm benchmark final matrix (choice guide: SKILL.md, *Local models (llm-hub)*). Two env
references they rely on are filled in by orch, not by the user:

- `${PROFILE_MODEL}` is the profile's resolved model slug. The claude profiles pin every Claude
  Code model tier (`ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_*_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`,
  `CLAUDE_CODE_SUBAGENT_MODEL`) to it.
- `${LLM_HUB_V1_URL}` is derived from `LLM_HUB_URL` at profile load: trailing slashes and one
  `/v1` are stripped, then exactly one `/v1` is appended, so `LLM_HUB_URL` may be set with or
  without it. An `LLM_HUB_V1_URL` already in the environment wins. The claude profiles use
  `LLM_HUB_URL` (Claude Code appends `/v1/messages` itself); the OpenAI-style clients
  (`local-llm`, `pi`, `copilot-llm-hub`, `opencode-llm-hub`) use `LLM_HUB_V1_URL`.

Existing installs reach this set through a one-time migration guarded by
`~/.harness-orch/.bench-local-migrated`. It retargets `claude-llm-hub` to `local-qwen3.6-35b` only
while it still runs a retired model (`local-lfm-8b`, `local-lfm-2.6b`, `local-qwen3-4b`) or the
old `local-ornith-1.0-35b` default. It removes `cursor-llm-hub` (stock `cursor-agent` cannot
reach a local endpoint) and `local-qwen3`, and renames `local-qwen` to `local-llm-fast`, each only
while it still runs a retired model, and rewrites every reference to them. It seeds the new
profiles and catalog entries without overwriting your own, and takes `opencode`, `local-llm` and
`pi` out of `settings.disabled_harnesses`. Once the marker exists, later edits are never
reverted; delete the marker to run it again.

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

## schedules/<id>/schedule.json

Written only by `dispatch.ts schedule`. `{id, name, cron, kind: "prompt"|"command", enabled, created_at,
updated_at, prompt, profile, model, command, workdir, timeout, next_at, last_run_at, runs[]}`. `model` is a
catalog model id the profile allows (`--model`), or null for the profile's default; a run passes it as
`ORCH_MODEL_ID`, the same override a chat turn uses. `updated_at` appears
after the first `schedule edit`, which changes only the fields it is given (checked as `add` checks them),
keeps `id`, `created_at`, `enabled` and `runs`, and recomputes `next_at`. Switching kind (`--prompt` on a
command schedule, `--command` on a prompt one) clears the other kind's fields. `next_at` is epoch seconds
(null when disabled). Each run is `{started_at, ended_at, kind, ref, status: running|ok|failed|lost, exit, model}` (`model`
as the run used it, null for the profile's default),
newest first, 30 kept. `ref` is a job id for a prompt run and a run directory (holding `command`, `out`,
`pid`, `exit`) for a command run.

## suggestions.json

```json
{ "generated_at": "2026-09-09T08:00:00Z", "suggestions": [ … ] }
```

Pending suggestions expire to `expired` after `settings.learning.dismiss_ttl_days` (default 30).
Mutate via `orch suggest scan|list|apply|dismiss` or `#/suggestions` in the dashboard.

## feedback/<id>.json

One file per item, written only by `dispatch.ts feedback …` and the `/api/feedback` routes
(`src/shared/types/feedback.ts`, `skills/orch/core/feedback.ts`).

```json
{ "id": "fb-20261117-1", "text": "Dashboard run list is slow", "source": "cli", "kind": "bug",
  "status": "working", "created": "ISO", "updated": "ISO", "work_run": "feedback-batch-20261117-191049Z",
  "result": null, "chat_id": null, "run_id": null, "node_id": null }
```

- `id`: `fb-<yyyymmdd>-<n>`, `n` = 1 + the highest number used that day (UTC).
- `kind`: `bug | idea | ux | other`. `source`: `chat | cli | ui`.
- `status`: `new` (added) → `queued` (`feedback work` put it in a batch run) → `working` (the batch
  run exists) → `done | wontfix` (set with `feedback update`). `work_run` and `result` are optional.
- Commands: `feedback add "<text>" [--kind K] [--source S] [--chat ID] [--run ID] [--node ID]`,
  `feedback list [--status S]`, `feedback show <id>`,
  `feedback update <id> [--status S] [--result "<text>"] [--work-run R]`,
  `feedback work [--ids a,b]`.
- `feedback work` with no `new` item prints `no new feedback`. It writes one run titled
  "feedback batch" with one node per item and a `validate` node after all items. It adds nodes
  only and dispatches nothing: the coordinator runs `run advance <run> --until-done`.
- Known gap: a `node add` that fails midway leaves the batch run on disk with partial nodes.
- The `/api/feedback` routes run `feedback work` through the CLI with `HARNESS_ORCH_HOME` set to the
  server home.

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
- `edges` are `[from, to]` pairs from `node add --after` (or `node update --after`, which replaces
  the node's incoming edges; a cycle is refused). A node is *ready* when it is `waiting`, has no
  `needs_user` and no `hold`, every incoming edge's source is `done`, and, when `after_all` is true (`--after '*'`,
  a gate node), every other non-gate node is `done` or `skipped`.
- `needs_user`: a reason string while the node waits on the user (`node update --needs-user`), else
  null/absent. `run health` shows such a node as `needs-user` with the reason; it is never ready.
  Each change appends a `deps` or `needs-user` event.
- `hold`: a reason string while the coordinator holds a ready node back (`node update --hold`,
  `--clear-hold`), else null/absent. `run health` shows such a node as `held`; it is never ready.
  Setting the node `running` clears it. Each change appends a `hold` event.
- Visibility fields on a node: `created`, `updated` (heartbeat), `notes` (last 20 `{at,text}`), `progress`,
  `owner` (agent id, job id or `coordinator`), `backfilled` (finished without ever running). Every
  change appends `{at,kind,node,from,to,note,by}` to `runs/<id>/events.jsonl`. Allowed moves:
  waiting->running|done|error|skipped (done/error from waiting is recorded as backfilled),
  running->done|error|waiting|skipped, error->waiting|running|skipped, skipped->waiting|running,
  done->waiting only with `--force`. `waiting` clears started, finished, error, owner and job_id.
  `settings.stale_minutes` (default 10) marks a quiet running node stale. `run sync` prints `stale:`
  and `unowned:` lines.
- `node report` stores `report: {reported_by: "inline", model, input_tokens, output_tokens,
  cache_read_tokens, usd, note, at}` on the node (and `model`). An omitted flag keeps the earlier
  value, else `null`; nothing is estimated. `run sync` prints one `reported:` line per such node
  after `slots:`, and `node digest` prints it too. The dashboard shows it as the node's usage when
  the harness reported no `cost`.
- One opencode session bound to several nodes (`node bind-owners`, `owners_fill_run`) is counted
  once in the run total. Nodes in a row: each later node gets what the session added after the
  earlier node's final share (`session_stats.baseline`). Nodes at the same time: the first node
  (earliest `started`, then node order) gets the full session cost and the others get 0 while it
  is open. Once its final share is set, the others get only what the session added after it.
- Node options from `node add`: `role` (planning, investigation, implementation, validation,
  conversation), `tier` (efficiency, balance, intelligence, fast), `plan_backed` (boolean) and
  `acceptance` (free text). Each is `null` or `false` when the node was added without it.
- `worker_identity` is `<run>/<node>/<attempt>` for a Claude dispatch and `null` otherwise.
  `metadata_transport` is `headers` (Claude), `preset-model` (other harnesses) or `null` (claude-native).
- `selection_history` holds the hub's selection events for the node, ordered by `seq` and capped at
  500. `last_event_sequence` is the highest stored `seq`, so `node selections` never re-appends an
  event. `requested_selector`, `main_model` (the model that served the latest solver stage) and
  `active_stages` (stages with no completion yet) are taken from the latest events.
- `node retry` and `run retry` reopen a finished run, reset failed nodes to `waiting`, archive
  their current fields into `attempts`, and redispatch unless `--no-dispatch` is set. Same-harness
  retries resume a recorded harness session when the adapter supports it. Manual retries are not
  blocked by `settings.max_attempts`; automatic retries are. Fallback/different
  harness retries restart from `prompt` with a note about partial work. `run sync`/`run advance`
  do the same automatically while attempts remain and backoff has elapsed.
- `run carry` moves the non-`done` nodes (and the edges between them) to a new run. Run fields:
  `continued_from` (on the new run: the old run id) and `continued_to` (on the old run: the new id).
  Node field `out_dir`: absolute handoff folder, set on a moved node whose folder already exists in
  the old run; absent otherwise. Moved nodes in the old run become `skipped` with
  `error: "moved to run <new>"`.
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

### Optional HTTPS listener (opt-in)

HTTP on `port` is the default and stays that way. Every internal caller (dashboard to `dispatch.ts`, watchdog,
CLI socket, service status, `/api/build`, tests, verify scripts) uses `http://127.0.0.1:<port>`; nothing redirects
to https, no HSTS, no `upgrade-insecure-requests`, no cookies. A second listener starts in the same process only
when `https_port` is non-zero, so a page can run in a secure context (microphone, clipboard, install to home screen).
Same app, routes and auth rules as HTTP. If it cannot start (certificate error, port busy) HTTP still runs and
`serve status` says why.

| Field | Meaning |
|---|---|
| `https_port` | `0` or missing = off (default). `6725` is the conventional port: `serve config https_port on` |
| `tls_mode` | `auto` (tailscale, then mkcert, then `localca`), `tailscale`, `mkcert`, `localca`, `selfsigned`, `files` |
| `tls_cert`, `tls_key` | absolute paths, `files` mode only |
| `secure_link_hint` | `true` (default): the dashboard may show a quiet, dismissable "Open the secure link" hint on a non-local http page after the microphone or clipboard was tried. `false` turns it off |

Certificates are made lazily on the first start of the HTTPS listener, under `<home>/tls/` (keys 0600, never logged
or served): `tailscale.crt/key` (from `tailscale cert`; needs HTTPS Certificates enabled in the Tailscale admin
console, DNS page), `mkcert.crt/key` (uses the existing mkcert CA only), `ca/ca.crt` + `ca/ca.key` and `leaf.crt/key`
(local CA mode: ECDSA P-256 root, 10 years, pathlen 0; 90-day leaf with serverAuth and SANs for localhost,
127.0.0.1, ::1, the hostname, `<hostname>.local`, the MagicDNS name and local IPs; re-issued when the IPs or names change),
`selfsigned.crt/key`. Renewal runs at boot and hourly (under 20 days left, or the name set changed) and hot-swaps
the HTTPS listener only. `serve tls renew` forces it and signals the server (SIGHUP).

Public routes on every listener, no token: `/ca.crt` (PEM, `application/x-x509-ca-cert`), `/ca.mobileconfig` (iOS
profile, `com.apple.security.root`), `/trust` (steps for iOS, Android, macOS, Windows and a QR of the secure URL).
They expose only the public CA. `GET /api/server-info` reports the HTTPS state (`https_url` is informational; no
generated link uses it, links keep the origin the user is on).

CLI: `serve config https_port 6725|on|off`, `serve config tls_mode <mode>`, `serve tls info` (source, expiry, CA
SHA-256, Tailscale hint), `serve tls renew`, `serve tls trust-help`. `serve status` and `service.ts status` print
`http: ...` and `https: off` or `https: <url> (cert: <source>, expires ...)`. `serve config set` keeps these keys.

`orch serve config show|get|set` reads and writes this file. `service.ts install` updates it;
`service.ts restart` (or `orch serve --stop` then `orch serve`) picks up edits. CLI
`--host`/`--port` on `orch serve` override for one shot only.

## chats.db (chat history)

Projects, chats, messages and attachment rows live in `<home>/chats.db` (SQLite, WAL, foreign keys on),
written **only by the dashboard server** through `bun:sqlite`, never by `dispatch.ts`. History is kept
forever: nothing prunes or deletes it; chats and projects are archived (`archived_at`), not removed.
Schema changes are numbered migrations recorded in `schema_migrations` and run at startup.

| Table | Holds |
|---|---|
| `projects` | `id, name, path (nullable), description, created_at, archived_at` |
| `chats` | `id, project_id, title, harness, profile, model_id (null = the profile's model), session_id, status idle\|running, created_at, updated_at, archived_at` |
| `messages` | `id, chat_id, role user\|assistant\|system\|tool, content, status pending\|streaming\|done\|error\|stopped, error, model_used, input_tokens, output_tokens, cost_usd, started_at, finished_at, created_at` |
| `attachments` | `id, chat_id, message_id (null until sent), filename, mime, size, sha256, rel_path, created_at` |
| `messages_fts` | FTS5 index of finished message text (search) |

- Ids are `<prj\|chat\|msg\|att>-` plus 16 base32 characters: 10 of millisecond time, 2 of a per-ms counter,
  4 random. They sort in creation order as plain strings, which is what cursor paging uses.
- An assistant message is written while it streams (`status: streaming`, `content` grows). At server
  start every message still `streaming` becomes `error: "server restarted"`.
- Uploaded files are stored content-addressed at `<home>/chats/files/<sha256[0:2]>/<sha256>` (identical
  content is stored once; the row keeps the original filename). Limits: 25 MB per file, 100 MB per
  message. The agent reads them through `<home>/chats/links/<att-id>/<filename>` symlinks.
- Harness, profile and model of a chat are fixed once it has a message. One live agent session per
  active chat is kept for 30 minutes of idleness; the stored `session_id` resumes it afterwards.
  Only `claude` is persistent (one `claude -p --input-format stream-json` process per chat); other
  harnesses run `dispatch.ts run --profile P` per message with `ORCH_RESUME_SESSION`.
- Test hooks (tests only): `ORCH_CHAT_CLAUDE_BIN` replaces the `claude` binary, `ORCH_CHAT_DISPATCH` the
  `dispatch.ts` path used by the per-message fallback.

API: `GET /api/chat-options`, `/api/projects*`, `/api/chats*`, `/api/attachments/{id}`. The request and
response schemas are the zod classes in `src/shared/dto/chats.ts` and the OpenAPI document at
`/api/openapi.json` (interactive page: `/api/docs`; committed copy: `docs/openapi.json`, refresh with `bun run openapi`). `GET /api/chats/{id}/events` is Server-Sent Events; event ids are
`<message id>.<text length>`, and `Last-Event-ID` replays what was missed from the database.

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
| `/api/profiles/{id}/usage`, `/api/harnesses/{id}/usage` | PATCH | body `{"usage":"chat\|runs\|both"}`; runs `dispatch.ts profile\|harness set-usage` |
| `/api/chat-options?use=runs` | GET | chat pickers list only chat-allowed profiles (`not_for_chat` names the left-out ones with the reason); `use=runs` lists the runs side (Schedules page) |
| `/api/harnesses` | GET | live probe per adapter (`dispatch.ts harness list --json`); `enabled` reflects `settings.disabled_harnesses` |
| `/api/memory` | GET, PUT | same shape with `outcomes` |

Every GET carries a strong `ETag` over the payload only (never `generated_at`), so the 2 s poll
answers 304 while nothing changes. A PUT sends `If-Match`; a stale one is refused with 412 and
the current etag, which is what stops the dashboard from clobbering a CLI write. Bodies are
capped at 4 MiB (413) and must be `application/json` (415).

## Subcommand grammar

```
dispatch.ts init
dispatch.ts profile list | show <name>
dispatch.ts memory add --profile P --outcome success|failure|partial [--kind K] [--note "…"]
dispatch.ts memory list [--profile P] [-n N]

dispatch.ts classify "<task>" [--complexity trivial|small|medium|large] [--prefer-local]
dispatch.ts budget-check

dispatch.ts run   (--profile <name> | <adapter>) <prompt|@file> [pass-through args…]
dispatch.ts start (--profile <name> | <adapter>) <prompt|@file> [pass-through args…]
dispatch.ts status <job-id> | tail <job-id> [-n N] | wait <job-id> [--timeout S] [--interval S] | list

dispatch.ts run start "<title>" [--id <run-id>]
dispatch.ts node add <run-id> <node-id> "<label>" [--after a,b] [--profile P] [--role R] [--tier T] [--model M] [--plan-backed] [--acceptance "<checks>"]
dispatch.ts node report <run-id> <node-id> [--model M] [--input-tokens N] [--output-tokens N] [--cache-read-tokens N] [--usd X] [--note "text"]
dispatch.ts node selections <run-id> <node-id>
dispatch.ts node dispatch <run-id> <node-id> [--profile <name> | <adapter>] <prompt|@file> [args…]
dispatch.ts node retry <run-id> <node-id> [--profile P | <adapter>] [--no-dispatch] [<prompt|@file>]
dispatch.ts node update <run-id> <node-id> [<status>] [--job J] [--error "msg"] [--at <iso>] [--owner <text>] [--force] [--after a,b|'*'|""] [--needs-user "reason"|--clear-needs-user] [--hold "reason"|--clear-hold]
dispatch.ts node ping <run-id> <node-id> [--note "text"] [--progress "3/10"]
dispatch.ts node batch <run-id> [--file F] [--dry-run]   # NDJSON ops on stdin or in F, one per line:
    {"op":"add","id":X,"goal"|"label":T,"after":"a,b"|[..],"profile","role","tier","model","plan_backed":bool,"acceptance"}
    {"op":"report","id":X,"model","input_tokens","output_tokens","cache_read_tokens","usd","note"}
    {"op":"update","id":X,"status":S (optional),"job","error","at","owner","force":bool,
     "after":"a,b"|[..]|"*"|"","needs_user":"reason","clear_needs_user":true,"hold":"reason","clear_hold":true}
    # applied in order in one process under one run lock via the same code as add/report/update
    # (same state and events.jsonl lines); all ops are validated first, any invalid op applies none
    # and prints `line N: <error>` (exit 2); one `line N: … ok` summary per op; unknown fields rejected.
    # Common ops run as one jq program (a few process starts per batch); an op it cannot check
    # (a dependency finished in a continued-from run) falls back to the per-op path. ORCH_BATCH_FAST=0 forces it.
dispatch.ts node remove <run-id> <node-id> [--force]
dispatch.ts run sync <run-id> [--no-retry]
dispatch.ts run wait <run-id> [--timeout SECS] [--stall-min N] [--json] [--follow] [--include-notes]
dispatch.ts run status <run-id> [--json]
dispatch.ts plan <run-id> "<goal>|@file" [--profile P] [--node ID]
dispatch.ts plan apply <run-id> [--file plan.json]
dispatch.ts run advance <run-id> [--until-done] [--interval SECS] [--timeout SECS] [--no-finish]
dispatch.ts run retry <run-id> [--profile P] [--no-dispatch]
dispatch.ts run carry <run-id> [--title T] [--id NEW-ID] [--keep-skipped] [--keep-open]
dispatch.ts msg send <run-id> --to orch|all|<node-id> [--from <node-id>|orch] "<text>"
dispatch.ts msg read <run-id> [--for orch|<node-id>] [--since N] [--all]
dispatch.ts run finish <run-id> [--status done|error] [--force --reason T]   # refused while run verify fails; the reason is stored as run.force_finish_reason
dispatch.ts run verify <run-id>                                    # the final gate: numbered failures, exit 0 only when clean
dispatch.ts req add <run-id> "<user ask>" [--id R1] [--node n1,n2]  # ledger: <run>/requirements.json (written only by req *)
dispatch.ts req link <run-id> <req-id> --node n
dispatch.ts req evidence <run-id> <req-id> --note "<text>" [--file path] [--test "bun test ..."]
dispatch.ts req status <run-id> <req-id> open|in_progress|implemented|verifying|done|superseded|waived [--reason T] [--verifier node] [--by n1,n2] [--force]   # waived needs --reason; done needs an independent verifier (or --force --reason). Old names not|partly|handled still work.
dispatch.ts req verify <run-id> <req-id> [--profile P]               # creates the verifier node (not an implementer, not its profile)
dispatch.ts req verdict <run-id> <req-id> pass|fail --node <verifier> [--note T] [--gap "<missing>" ...]   # only the verifier; fail creates one gap node per --gap
dispatch.ts req list <run-id> [--json]
dispatch.ts req check <run-id>                                     # exit 1 unless every requirement is done, superseded or waived
dispatch.ts run list

dispatch.ts serve [--host H] [--port P] | serve --stop
dispatch.ts serve status [--json]
dispatch.ts serve recover [--start|--no-start]
dispatch.ts serve config show | serve config get <key> | serve config set [--host H] [--port P] [--require-token|--no-require-token] [--allow-remote|--no-allow-remote]
dispatch.ts ui [--stop]
dispatch.ts sync [--no-serve]
dispatch.ts feedback add "<text>" [--kind bug|idea|ux|other] [--source chat|cli|ui] [--chat <id>] [--run <id>] [--node <id>]
dispatch.ts feedback list [--status new|queued|working|done|wontfix] | show <id>
dispatch.ts feedback update <id> [--status <s>] [--result "<text>"] [--work-run <run-id>]
dispatch.ts feedback work [--ids fb-a,fb-b]
dispatch.ts prune [--older-than <N>d|<N>h|<N>] [--dry-run]
```

`run` is overloaded: `run start|finish|list|sync|advance` is run-state; any other second word is the v1
`run <adapter|--profile>` foreground dispatch. Adapter names never collide with those five words.

Exit codes: `0` ok · `1` environment/request failure · `2` bad arguments or unknown id ·
`124` `wait` timed out · `127` required binary missing.

## Usage limits (chat / runs)

Enforcement: `run`, `start`, node dispatch, loops, watches, schedules and `plan` refuse a chat-only
profile or harness (`profile X is chat-only (profiles.X.usage)` / `harness H is chat-only
(settings.harness_usage.H)`), exit 2. `profile pick`, the plan menu and the retry fallback skip them.
Chat turns run with `ORCH_USE=chat`, so they refuse runs-only profiles; `ORCH_USE=any` (sanity) skips the check.
Creating a chat or moving one to a runs-only profile answers 400. A chat already on a profile that
became runs-only keeps working and shows an amber warning. `profile sanity` adds `warnings` when
`planner_profile` or `default_profile` is not runs-enabled. `profile list [--for chat|runs] [--json]`,
`harness list --json` (`usage`).

### Push state (`<home>/push/`)

`vapid.json` (0600): the VAPID key pair, generated once with WebCrypto (ES256); only the public key is served (`/api/push/key`). `subscriptions.json` (0600): one record per device (endpoint, keys, label, user agent, app, categories, quiet hours, last success and error). Written only by the server. A 404 or 410 from a push service removes the record. Sending is hand-written (RFC 8291 aes128gcm, RFC 8292 VAPID, tested against the RFC vector) and goes only to the endpoint of the subscription; endpoints must be https (http only on loopback). Push works only on the HTTPS listener or localhost (see the HTTPS section above).

## Requirements ledger and done gate

`<run>/requirements.json`: `{requirements:[{id,text,status,reason,nodes[],evidence[{note,file,test,at}],created,updated}]}`.
Status starts `not`. `run start` adds the node `done-gate` (role `validation`, `after_all`, so it runs last; a node
added after it ran resets it to `waiting`). Its prompt runs `run verify` and writes the result as its handoff.
`ORCH_NO_DONE_GATE=1` starts a run without it (the test helpers set it). `run verify` fails on: a node not done or skipped,
a done node with an empty handoff or marked `unverified`, a `validation` node that is not done, an open requirement,
a node with `needs_user` or `hold`, an unanswered ask in `inbox/orch`. `run finish` and `run advance` refuse while it fails.
