# Status bridge

`core/commands/announce.ts` makes orch work visible where the harness only sees its own turn. While agents, background commands, watches and loops run, Herdr and the status line otherwise show the session as idle.

## What it does

It reads orch state directly (`runs/*/state.json` with status `running`, `loops/*/state.json`, `watches/*/state.json`; loops and watches count only when their pid is alive). It builds one short summary, for example `orch: 3 running, 2/16 done · 1 loop · 2 monitors`, capped at 120 characters. With nothing running it clears what it set.

Flags: `--run <id>` (one run), `--ttl-sec N` (default 120), `--dry-run` (print commands and file contents, send nothing), `--clear`, `--quiet`. It always exits 0.

## Herdr authority rule

The pane has `full_lifecycle_hook_authority`: the harness's own Herdr plugin (source `herdr:opencode`) owns the semantic state (idle, working, blocked). A second source must never call `pane report-agent`. The bridge uses only `pane report-metadata --source user:orch`, which is display-only: it sets `--state-label idle=` and `working=` and `--token orch=` and leaves semantic state untouched. `--agent` is the pane's own label (from `herdr pane current`, default `orch`). The TTL (`--ttl-ms`) makes the text expire if orch stops refreshing. Clearing uses `--clear-state-labels --clear-token orch --clear-title` under the same source. It runs only when `HERDR_ENV=1`, `HERDR_PANE_ID` is set and the binary exists (`HERDR_BIN_PATH`, else `herdr`). Calls have a 5 s timeout (`ANNOUNCE_HERDR_TIMEOUT`) and failures are ignored.

## Files and JSON contract

1. `~/.harness-orch/activity/<session-id>.json`, harness-neutral, always written:
   `{"active":bool,"updated_at":<epoch secs>,"running":N,"done":D,"total":T,"summary":"..."}`
2. `~/.claude/workflow-active/<session-id>`, written only when `agent_harness` is `claude`: `{"active":bool,"updated_at":<epoch secs>}`. harness-status-line shows `⚙ workflow active` while it is `true` and not older than 120 s.

Both are written atomically (tmp file then `mv`), mode 0600, directories created. `active:false` is written when nothing runs. Readers must treat `updated_at` older than the TTL as inactive.

Session id: `agent_session_id` from `hooks/agent-env.sh` when present, else `$CLAUDE_CODE_SESSION_ID`, `$OPENCODE_SESSION_ID`, else `pid-<ppid>`.

## Automatic wiring

`dispatch.ts` calls `orch announce --quiet` in the background from an EXIT trap after `run start|finish|sync|carry` and `node update|report|ping|dispatch`. The caller's exit code and output do not change. Rules:

1. Debounce: skipped when the last announce started under 5 s ago (`<home>/.announce-ts`, written atomically). The last change inside a window shows at the next mutation or the next refresh; the TTL covers the rest.
2. No-op when neither `HERDR_ENV=1` nor `CLAUDE_CODE_SESSION_ID`/`OPENCODE_SESSION_ID` is set.
3. No-op when `ORCH_NO_ANNOUNCE=1`. The dashboard reconciler (`src/server/runs/run-reconciler.ts`) sets it, because the server is not in a Herdr pane. The `*.test.sh` suites export it so they never touch a real pane.

`dispatch.ts announce [--clear|--dry-run|--quiet|--run <id>|--ttl-sec N]` runs it by hand.

## TTL refresh

The label expires after 120 s. `orch announce --daemon` keeps it fresh: the announce hook starts one daemon per home the first time it runs while something is running (pidfile `<home>/announce.pid`, log `<home>/announce.log` capped at 100 KB). It refreshes every activity file and Herdr label every 20 s, exits after 10 minutes with nothing running, and stops on `orch announce --clear`. Do not run a `run sync` watch for freshness. Env: `ANNOUNCE_INTERVAL` (s), `ANNOUNCE_IDLE_SECS`, `ANNOUNCE_NO_DAEMON=1`.

## Clearing semantics (Herdr 0.9.5 docs)

- `--title`, `--display-agent` and `--state-label` are presentation fields with source-scoped expiry. `--clear-title` and `--clear-state-labels` act on what this `--source` set.
- Tokens are not source-scoped: the reporter owns clearing. The bridge uses the token key `orch` (not a generic name like `summary`) and clears only `--clear-token orch`.
- With `--ttl-ms`, each token key and the labels expire by themselves.

## Open item: harness-status-line

The opencode path (`src/opencode/activityTracker.ts` in harness-status-line) reads only opencode's session state. It should also read `~/.harness-orch/activity/<session-id>.json` and show the workflow segment while `active` is true and `updated_at` is under 120 s old.
