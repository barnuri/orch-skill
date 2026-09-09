# Adapter Contract

`scripts/dispatch.sh` dispatches to a target harness through a small set of shell functions named
`adapter_<name>`, defined in `scripts/lib/adapters.sh`. This is the contract every adapter follows,
how profiles feed into them, and the steps to add a new one.

## Script layout

| File | Holds |
|---|---|
| `scripts/dispatch.sh` | Entrypoint: constants, symlink-safe self-resolution, `main`, classify, budget-check, job plumbing (`run`/`start`/`status`/`tail`/`wait`/`list`). Sources every `scripts/lib/*.sh`. |
| `scripts/lib/adapters.sh` | `resolve_prompt`, the `adapter_*` functions, `adapter_dispatch`, `dispatch_with_profile` |
| `scripts/lib/config.sh` | Config home (`~/.harness-orch`), `init`, settings, `profile_load`, `profile`/`memory` subcommands |
| `scripts/lib/runs.sh` | Run/node state, `node dispatch`, `prune` |
| `scripts/lib/serve.sh` | Dashboard server lifecycle: `serve` (foreground `exec`) and `ui` (start-or-reuse, restart on newer sources, `--stop`) |
| `scripts/typecheck.sh` | Type gate for the TypeScript half — bundles the dashboard, then `tsc` over browser and server sources. Exits 0 with a SKIP line when bun is absent |
| `server/` | The Bun HTTP server: `main.ts` entrypoint, `app.ts` routes, plus `routes/`, `validation/`, `documents/`, `runs/`, `files/`, `http/` |
| `dashboard/` | `index.html` shell and the `src/` browser modules it bundles |
| `shared/types/` | Interfaces used by both halves — types only, no runtime code, no `Bun.` |

Libs are sourced, never executed, and contain no top-level side effects beyond defining functions
and constants.

## Function signature

```
adapter_<name> <prompt> [pass-through args...]
```

- `$1` is the fully-resolved prompt text (never an `@file` token — `resolve_prompt` already read
  the file before an adapter sees it).
- Remaining args are appended verbatim to the underlying CLI/request. When a profile is in play
  they arrive already prefixed by the profile's model flag and `flags` (see below).
- Output: the harness's response on **stdout**; progress/diagnostics on **stderr**. `run` streams
  both live; `start` redirects both into the job's `log`.
- Exit code: propagate the underlying CLI/request's. `127` = required binary not on PATH,
  `1` = request/transport failure, `2` = bad arguments.

## Existing adapters

| Adapter | Target | Invocation |
|---|---|---|
| `claude-native` | none — sentinel | Prints a notice, exits 0. `SKILL.md` handles this result before ever calling `run`/`start`; the function only exists so direct scripting against `dispatch.sh` gets defined behavior. |
| `claude` | `claude` CLI (headless) | `claude -p "<prompt>" --output-format text [args…]` |
| `cursor-agent` | `cursor-agent` CLI | `cursor-agent -p "<prompt>" --output-format text --force [args…]` (`--force`: no TTY to approve tool calls) |
| `opencode` | `opencode` CLI | `opencode run "<prompt>" --auto [args…]` (`--auto`: no TTY to approve permissions) |
| `local-llm` | OpenAI-compatible HTTP | POST `{model, messages:[{role:user,content}], stream:false}` to `$LLM_HUB_URL/chat/completions`; model from `$LLM_HUB_MODEL` (default `local-model`), timeout `$LLM_HUB_TIMEOUT` (default 120 s); prints `.choices[0].message.content`. |

## Profiles → adapter arguments

`dispatch_with_profile <profile> <prompt> [args…]` calls `profile_load` (which exports the
profile's `env` and checks its `auth` names), then invokes `adapter_dispatch` with the profile's
`harness` as the adapter name and this argument order:

```
<model flag>  <profile flags…>  <caller pass-through args…>
```

| Harness | Model flag when `model` is non-empty |
|---|---|
| `claude`, `cursor-agent` | `--model <model>` |
| `opencode` | `-m <model>` |
| `local-llm` | none — exported as `LLM_HUB_MODEL=<model>` instead |

Profiles never store secret values; see `references/state-and-config.md` for the schema.

## Adding an adapter

1. Write `adapter_<name>() { ... }` in `lib/adapters.sh` following the signature above. Guard
   required binaries with `require_bin adapter_<name> <binary> || return $?` — it emits the
   uniform `<caller>: <binary> not found on PATH` line and returns 127.
2. Add one `case` arm in `adapter_dispatch()` mapping the name to the function, and add the name to
   `VALID_HARNESSES` in `lib/config.sh` so profiles may target it.
3. If the harness takes a model flag, add a `case` arm in `dispatch_with_profile()`.
4. If `classify` should ever pick it, add a branch to `classify_cmd()` in `scripts/dispatch.sh`
   (and the adapter list in its `usage()`), then extend the `classify prints → Use` table in
   `SKILL.md`.
5. Add tests to `dispatch.test.sh`: at minimum the "binary missing" path (strip its dir from
   `PATH` with `path_without`) and, via a fake CLI shim on a temp `PATH`, the exact argv shape.
