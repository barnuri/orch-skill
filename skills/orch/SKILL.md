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

All mechanics live in `<skill-dir>/scripts/dispatch.ts` (`<skill-dir>` is this skill's base
directory, stated by the harness when it loads the skill). Below, `orch <sub>` is shorthand for
`bun <skill-dir>/scripts/dispatch.ts <sub>`. Never re-implement what the script does, and never
hand-edit the files it owns — every mutation goes through a subcommand so the dashboard stays true.

Everything user-facing lives in `~/.harness-orch/` (override with `HARNESS_ORCH_HOME`):
`profiles.json`, `memory.json`, `runs/`, `jobs/`, `serve.token`, `serve/`. Schemas and the full
subcommand grammar: [state-and-config.md](references/state-and-config.md).

## Step 0 — Bootstrap (once per machine, idempotent)

orch requires Bun. Check it first: `command -v bun`. If it prints nothing, tell the user: "orch requires bun: install it from https://bun.sh (curl -fsSL https://bun.sh/install | bash), then run this command again", and stop. `dispatch.ts` exits 127 with the same message when bun is missing.

```bash
dispatch.ts doctor    # bun version, home path, herdr availability
orch init            # creates ~/.harness-orch with template profiles.json and an empty memory.json
orch profile list    # name, harness, model — `*` marks settings.default_profile; `--for chat|runs`, `--json`
orch profile set-usage <name> chat|runs|both   # limit a profile to the chat page, orch runs, or both
orch harness set-usage <id> chat|runs|both     # same for a harness; a chat-only profile or harness is refused by run/start/nodes/loops/schedules
orch memory list -n 20
```

`init` never overwrites a profiles.json the user has edited. If `profile list` shows a profile
whose `auth` env var is missing on this machine, say so — do not try to supply credentials.
`profiles.json` holds env-var **names** and `${VAR}` references only; never write a secret value
into it.

## Step 1 — Choose a profile

Precedence, highest first:

1. **The user named a target** ("send this to cursor", "use claude-llm-hub") → that profile or adapter.
2. **Memory hint** — a `memory list` row whose `task_kind`/note matches this kind of task and
   whose outcome was `success` → its profile. Failures count against a profile for that kind.
3. **`profile pick`** — `orch profile pick "<task>" [--complexity …] [--kind K]` prints
   `profile=`, `model=` (catalog id), and `reason=` using metadata, memory and `budget-check`.
   Only use a `model` inside that profile's allowed catalog ids (`orch model list --profile P`).
4. **Classifier** — `orch classify "<task>" [--complexity trivial|small|medium|large] [--prefer-local]`
   prints one adapter; map it to a profile:

| classify prints | Use |
|---|---|
| `claude-native` | do the work in this session — Step 2 |
| `claude` | `profile pick` among the subscription tiers — `claude-haiku` (Haiku 5.5: trivial–small), `claude-default` (Sonnet: medium–large, default), `claude-planner` (Opus 1M, xhigh: planning), `claude-opus` (large); or `claude-llm-hub` when the user wants the LLM hub route |
| `cursor-agent` | `cursor-default` |
| `opencode` | `opencode-default`; `opencode-llm-hub` for local coding |
| `copilot` | `copilot-default` |
| `local-llm` | a [local profile](#local-models-llm-hub) — `claude-llm-hub` when the task needs tools, `local-llm-fast` for trivial plain text |

The classifier's policy (top rule wins): trivial/small **and** `budget-check` passes →
`claude-native`; `budget-check` fails (this Claude session near its subscription limit) → first
available of `cursor-agent` → `opencode` → `copilot` → `local-llm` → `claude-native` with a
warning; `--prefer-local` or medium with `LLM_HUB_URL` set → `local-llm`; otherwise
`claude-native`.
`orch budget-check` is callable alone (exit 0 safe / 1 avoid); a missing, stale or
non-subscription snapshot always counts as safe.

Harnesses listed in `settings.disabled_harnesses` are off: `profile pick` never returns their
profiles and the dashboard hides them. The template disables none and makes `claude-default`
(Claude Code, Sonnet) the default profile; when the classifier's answer maps to a harness the
user disabled, use `settings.default_profile` instead.

### Local models (llm-hub)

Each profile runs a model from the 2026-10-04 local-llm benchmark final matrix. Times are the
A/B/C task wall times for that harness and model pair.

| Profile | Model | Use it for | Bench evidence |
|---|---|---|---|
| `claude-llm-hub` | qwen3.6-35b (local default) | implement and bulk work with tools | 15/15, the fastest Claude pair (23/38/55 s) |
| `claude-llm-hub-planner` | ornith-1.5-35b | local planning and decomposition, large tasks | 15/15, the strongest planning model |
| `copilot-llm-hub` | qwen3.6-35b | the same work under Copilot CLI (BYOK); `claude-llm-hub`'s fallback | 15/15 (27/44/51 s) |
| `opencode-llm-hub` | qwen3-coder-next | coding only | 14/14, the best opencode pair (35/62/42 s) |
| `pi-llm-hub` | ornith-1.5-35b | the fastest local agent | the fastest pair overall (17/40/32 s) |
| `local-llm-fast` | ornith-1.5-9b | trivial text: format, classify; no tools | the smallest model to pass 15/15 |

llama-swap holds one big model at a time, so the 35B profiles are serial (`parallel_ok: false`);
only `local-llm-fast` runs in parallel. Cursor cannot use local models: stock `cursor-agent`
cannot reach a local endpoint. orch derives `LLM_HUB_V1_URL` (the base with exactly one trailing
`/v1`) from `LLM_HUB_URL`; the claude profiles use `LLM_HUB_URL`, and every OpenAI-style client
(`local-llm`, `pi`, `copilot-llm-hub`, `opencode-llm-hub`) uses `LLM_HUB_V1_URL`.

If the choice materially changes cost or risk and none of the three sources settles it, ask the user
(see "Asking the user" below). Dispatching to a paid CLI is not free to undo.

### llm-hub native mode (the hub picks every model)

When `dispatch.ts hub status` prints `mode: smart-auto`, do not pick models or profiles. llm-hub is
the model brain. orch runs the graph, loops and monitors.

- Setup, once: `dispatch.ts hub setup [--harness opencode|claude|copilot|pi]` (default opencode).
  It checks `$LLM_HUB_URL/healthz`, enables the harness, makes `<harness>-smart-auto` the default
  and planner profile, and turns the mode on. `hub off` turns it off.
- Give every node a `--role` (planning, investigation, implementation, validation, conversation)
  and no `--profile`. The role sets the tier from `settings.llm_hub.role_tiers` (planning →
  intelligence, implementation and investigation → balance, validation → efficiency, conversation
  → fast). Pass `--tier` only to override. Pass `--acceptance` so the hub learns from the result.
- `plan` gives the planner node role planning, and `plan apply` passes each task's `role`
  (default implementation).
- Each dispatch records `.hub.expected` (from `/api/smart-auto/resolve`). `run sync` records
  `.hub.actual` (the model the hub used) and posts `tests_passed` to
  `/api/smart-auto/outcome` for a node with acceptance checks that ended done. `hub resolve <tier> [<role>]`
  previews a pick.

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
1. `Bash(run_in_background: true)`: `orch run --profile <name> "<prompt>" > <file> 2>&1` — the
   harness owns the backgrounding, so the script runs synchronously and streams. Redirect to a
   file you choose; what you keep is the **path**, not the answer.
2. Attach `Monitor` to the returned task; filter for progress **and** failure signatures only —
   never a raw log tail, or the node's output streams into your context line by line.
3. On completion the exit code is the harness's own. Read the file only if you must decide
   something from it, and then read a bounded slice (`head`, `grep`), not the whole thing. If the
   answer is input for another task, pass the path instead of the text.

**Fallback Tier**
1. `orch start --profile <name> "<prompt>"` → prints a job-id (self-backgrounds via `nohup`).
2. `orch status <job-id>` across turns, or block once: `orch wait <job-id> --timeout 300`
   (exit 124 = still running).
3. `orch tail <job-id> -n N` for a bounded look — always pass `-n`. `orch list` shows every job
   with its profile.

### Multi-node run (a DAG of tasks)

Emit one command per state change; the dashboard reads `state.json` live, so it is current the
moment a command returns — nothing to re-render. Shell state does
not survive between tool calls, so `run start` prints the run id — copy that literal `<run-id>`
into every following command (and hand the user its dashboard link, `#/run/<run-id>`).

```bash
orch run start "<title>"                                   # prints <run-id>; auto-prunes old runs first
orch node add <run-id> plan   "Plan the change"
orch node add <run-id> impl   "Implement"    --after plan --profile claude-llm-hub
orch node add <run-id> tests  "Write tests"  --after plan --profile local-llm-fast
orch node add <run-id> review "Review + fix" --after impl,tests --profile cursor-default
orch run sync <run-id>                     # prints id<TAB>status per node, then "ready: plan", "running: 0"
```

`node add` takes optional metadata for a node. `--role planning|investigation|implementation|validation|conversation`
states the kind of work, `--tier efficiency|balance|intelligence|fast` picks the Smart Auto tier,
`--plan-backed` marks a node that has a plan reference, expected files and acceptance checks, and
`--acceptance "<checks>"` records those checks as free text. Every option is optional and stored
on the node; `--role` and `--tier` are validated when the node is added. Claude nodes send the role,
tier and worker identity to llm-hub as headers; other harnesses get only the preset model id (see
Adapters below).

For more than one node op, prefer one `orch node batch <run-id>` over separate calls: pipe one JSON
op per line on stdin (or `--file F`) — `{"op":"add","id":"x","goal":"…","after":["a"]}`,
`{"op":"report","id":"x","note":"…"}`, `{"op":"update","id":"x","status":"done","owner":"…"}` (fields
mirror the flags) — and they apply in order in one process under one run lock, with the same state
and events as the single commands. Every op is checked first; one bad op applies none and each
error names its line. `--dry-run` only validates. Still start and finish nodes live, not afterwards.

To see which model the hub actually picked for a node, run
`orch node selections <run-id> <node-id>`. It appends the hub's selection events for every attempt
of the node, skips any it already has, and leaves the node's `main_model` and `active_stages` current.

Loop until every node is terminal:
1. For each id in `ready:` — `orch node dispatch <run-id> <node-id> "<prompt>"` (uses the node's
   own `--profile`; pass `--profile P` or an adapter to override). It starts the job and marks
   the node `running`. A `claude-native` node is done inline (Step 2) with `node update` instead.
   End every dispatched prompt with the handoff instruction: **"Write your handoff — what you
   did, what the next task needs to know, and any file it must read — into `$ORCH_NODE_OUT`."**
   That variable is exported into the node; you never interpolate the path.
2. Native Tier: `Monitor` the dispatched jobs only for progress and failure signatures. Never
   tail a job log into the conversation. Fallback Tier: nothing to attach.
3. `orch run sync <run-id>` — flips finished jobs to `done`/`error`, prints the next `ready:`
   set. Its output is bounded by design. Poll with `run sync`, not by reading files.
4. When a node finishes and you need to judge it, `orch node digest <run-id> <node-id>` — status,
   exit code, size, and a head+tail excerpt. Never `tail` or `TaskOutput` the whole log.
5. Skip a node the plan no longer needs: `orch node update <run-id> <node-id> skipped`.

Keep coordinator output short:
- Run `orch use <run-id>` once. Then pass `.` as the run id to `node update|report|batch` and
  `run sync` (for example `orch run sync .`).
- Do not repeat the shared subagent rules in each prompt. Write one line instead:
  "Follow `<skill-dir>/references/agent-rules.md`." Add only the rules that are specific to the task.
- Set the shell tool's working directory with its workdir argument. Do not prefix commands with
  `cd <repo> &&`. One measured run had 173 repeated shell preambles (153k chars) and 52 repeated
  rule blocks in prompts (178k chars).
### Planned run (a planner agent splits the work)

When the split itself is the hard part, hand it to the planner instead of writing nodes by hand:

```bash
orch run start "<title>"                     # prints <run-id>
orch plan <run-id> "<goal>"                  # or @/path/to/goal.md; dispatches the planner node
orch run advance <run-id> --until-done       # applies the plan, dispatches, finishes the run
```

- `plan` runs on `settings.planner_profile` (template: `claude-planner` — Claude Code on
  Opus with the 1M context and `--effort xhigh`). The
  planner writes `plan.json` — `{summary, tasks:[{id, label, profile, after, prompt}]}` — into
  its out dir. Tasks default to `settings.default_profile` (`claude-default`); the planner
  assigns `claude-haiku` to small isolated tasks.
- `run advance` is one scheduler step: `run sync`, apply a finished plan (`plan apply`
  validates ids, deps, cycles, `settings.max_nodes` and profiles, then adds the nodes with their
  stored prompts), and dispatch every ready node that has a stored prompt, up to
  `settings.max_parallel` running at once. Tasks with no dependency between them run in
  parallel. The dashboard graph shows each parallel stage and where the stages merge.
  `--until-done` loops and finishes the run. Exit 3 means blocked: a node errored or is waiting
  on a node with no stored prompt. Native Tier runs it in the background under `Monitor`;
  Fallback Tier calls `run advance` (without `--until-done`) once per turn.
- To plan it yourself, write the same JSON and run `orch plan apply <run-id> --file plan.json`.

### Retry and resume

Every dispatch stores the prompt reference/text and pass-through args on the node. A failed node
can be retried without rebuilding the prompt:

```bash
orch node retry <run-id> <node-id> [--profile P | <adapter>] [--no-dispatch] [<prompt|@file>]
orch run retry <run-id> [--profile P] [--no-dispatch]
```

`node retry` works for `error` and `skipped` nodes. It archives the failed attempt, clears the
node back to `waiting`, reopens a finished run, and redispatches unless `--no-dispatch` is set or
the node has no stored prompt. For old nodes that predate prompt storage, pass a prompt on
`node retry`; with `--no-dispatch` this only stores the prompt and leaves the node waiting.
`run retry` does that for every errored node with a stored prompt and obeys `settings.max_parallel`;
extra nodes stay `waiting` for `run advance`.

`run sync` and `run advance` automatically retry errored nodes with stored prompts until
`settings.max_attempts` is reached (template: `5`; set `1` to disable, `-1` for unlimited).
Automatic retries wait until the node's `next_retry_at`, using an exponential backoff of at
least the `run advance --interval` value (capped at 5 minutes), so unlimited does not spin.
Quota/rate/auth-looking failures use the profile's `fallback` profile when that fallback is
enabled; otherwise the same profile is retried.

Retry continues when it can. If the same resumable harness is used and the node has a session id,
orch resumes that session and sends a short continuation prompt. If the retry switches harnesses
or has no resumable session, orch restarts from the stored original prompt with a warning that
partial work may already exist in the repo and `$ORCH_NODE_OUT`. The node output directory is
kept across attempts.

**Carry a run forward** with `orch run carry <run-id> [--title T] [--id NEW-ID] [--keep-skipped] [--keep-open]`.
It starts a new run and moves every node that is not `done` into it, with the edges between them.
Skipped nodes stay behind unless `--keep-skipped`. Running nodes move untouched: they keep their
job id, session and start time, and keep their handoff folder in the old run (`node out` in the new
run prints the old path). The old run marks moved nodes `skipped` (`moved to run <new>`) and closes
as `done`, unless `--keep-open`. `--title` sets the new title (default `<old title> (continued)`).
The new run records `continued_from`, the old run records `continued_to`. Prints the new run id.

**Stop a run** with `orch run stop <run-id>`, or the dashboard's **Stop run** button. Running
jobs get `SIGTERM`, running nodes become errors with the message `cancelled`, waiting nodes are
skipped, and the run status becomes `cancelled`. Automatic retries skip a cancelled run. Use it
also for a run left on `running` after its coordinator stopped.

Manual retry is always allowed, even after automatic attempts are spent. That one extra dispatch
is counted too, so the dashboard may show `manual retry 6` or `attempt 6/5`; automatic retries
still remain stopped after it fails.

**Talking between sessions.** Every run has a mailbox, `runs/<run-id>/messages.jsonl`. Planned
task prompts already tell the node how to use it, and `$ORCH_DISPATCH` points it at this script:

```bash
orch msg send <run-id> --to orch|all|<node-id> "<text>"   # inside a node, --from defaults to it
orch msg read <run-id> [--for orch|<node-id>] [--since N] [--all]
```

Check `msg read <run-id>` whenever `run advance` returns: that is where a node reports blockers
and scope changes. If `herdr` is on `PATH`, each message also triggers a herdr notification
(best effort; herdr is optional).

**Herdr panes (dedicated instance).** When `herdr` is installed, `start` (and so loops, schedule
runs and `node dispatch`) runs each job in a pane of a second, headless herdr server that only orch
uses, under `<orch-home>/herdr/`. It is never your live herdr session. One tab per run, one pane
per job, titled `<run> <node> <job-id>`. A pane closes 60 s after a successful exit; a failed job's
pane stays open (cap 20 panes). The job wrapper still writes the log and `exit_code`, so `status`,
`wait`, retry and resume work the same. If herdr is missing, the instance cannot start, or
`ORCH_HERDR=0` is set, the job starts detached as before. The dashboard never depends on it.
`orch herdr status` shows the state and the command to look at it (`orch herdr attach`); run it in a
separate terminal, never inside your own herdr pane. Details: `references/herdr.md`.

**When herdr is active, fan out and let nodes talk.** Dispatch every independent ready node at once
(one `node dispatch` per node, no waiting between them) up to `max_parallel`; each gets its own pane.
`node dispatch` prints the node's pane id and instance `HOME` on stderr (the job dir also holds
`herdr_pane` and `herdr_home`). Tell each node in its prompt that it may message a sibling node
directly: `HOME=<herdr_home> herdr pane read <pane>` to see its output, and
`HOME=<herdr_home> herdr pane send-text <pane> "<text>"` then `send-keys <pane> Enter` to talk to it.
Use this for quick coordination (an interface both sides need, a file one is about to change).
Record every decision with `orch msg send` too: panes close after exit, the mailbox stays.

### Passing work between nodes

Nodes hand work to each other through the filesystem; the orchestrator moves **paths**, never
content. Each node owns `orch node out <run-id> <node-id>` — a directory created at dispatch and
exported to it as `$ORCH_NODE_OUT`.

```bash
orch node dispatch <run-id> impl "Implement the parser. Write your handoff into \$ORCH_NODE_OUT."
orch node dispatch <run-id> review \
  "Review the parser work. Read the handoff in $(orch node out <run-id> impl) first."
```

The out dir is the **handoff channel, not the work product**. A code node still edits the repo
directly; what goes in the out dir is the summary and anything the next node must read. It lives
under the run, so `prune` reclaims it with the run.

A prompt too long to sit in your own context goes in a file and is passed as `@/path/to/file`.

**The rule:** your context should not grow with a node's output. If you are about to read a whole
log, a whole answer, or a whole file a node produced, stop — pass its path to whoever needs it, or
read a bounded slice.

Finish and learn:

```bash
orch run finish <run-id>                    # auto-records memory + scans suggestions when learning is on
orch memory add --profile claude-llm-hub --outcome success --kind "implement" --note "fast, clean diff"
orch suggest list --pending                 # review before applying profile/metadata changes
```

`run finish` with default `settings.learning` auto-appends memory rows and scans for gaps.
Add one memory row per profile actually used, honest about the outcome — this is what Step 1
reads next time. Check `#/suggestions` for profile/model description and routing hints.

## Keep the graph true

The dashboard shows what the graph says, not what is happening. Keep it honest:

- Start a node when the work starts (`node update ... running --owner <agent id|job id|coordinator>`) and finish it when the work ends, never in a batch afterwards. Use `--at <iso>` for a real time that already passed.
- During long work, `node ping <run> <node> --note "..." --progress 3/10` at least every 10 minutes. A running node quiet for `settings.stale_minutes` turns `stale`.
- `node report` records model and tokens.
- Pass the real session id in `--owner ses_xxx`. If you cannot, `node bind-owners` (run by `run sync`) finds the session; a node it cannot bind shows `unbound` with the reason, and one with no owner for 2 min shows `unowned`.
- Start every agent with `orch node brief <run> <node>` and paste the output into its prompt: it tells the agent to ping, report, and end with `done` (verified) or `error`. `node verify-owners` (also run by `run status`, `run sync` and the dashboard) closes a node whose owner finished or vanished; such a node is `done` but unreviewed. Hook adapters: `references/harness-adapters.md`.
- orch announces running work to Herdr and the status line automatically. A background daemon (`orch announce --daemon`) keeps both fresh every 20 s: no `run sync` watch is needed for freshness (details in `references/status-bridge.md`).
- After dispatching work, start `run wait <run>` as a background command. When it ends, report in one line and start it again. Reporting then does not depend on being asked. `run status <run>` is the one-liner for a progress update. Before any node status goes to the user, run `run status <run> --fresh`: its `fresh` line is read from `state.json` in that step, never from an earlier check. A node marked done with no non-empty `handoff.md` in its output dir prints `done without handoff` and is marked `unverified`.

Mistakes to avoid (see [references/lessons.md](references/lessons.md)):

- Never mark a node running unless something is doing the work, and name the owner. `run sync` prints `unowned:` otherwise.
- Never discard a command's output (no `>/dev/null`, no `2>/dev/null`). Read the result of `node add`, `update` and `report`.
- A carried run's finished nodes live in the origin run: `node add --after X` accepts them.
- Verify with `run status` after you change the graph.
- Set a node back to `waiting` only with `node update waiting`: it resets the node. Remove a mistaken node with `node remove`.

## Commit and restart at safe points

When the user has allowed commits without push, the coordinator commits and refreshes the service as
work lands, not at the end. After a node's own tests pass: commit that node's files by path as one
logical commit (no co-author, never push, never another session's files), run
`bun scripts/service.ts restart` if the repo has the orch dashboard service, and confirm
`/api/build` reports `stale:false`. Without commit permission, do not commit; ask once through the
user-question tool and remember the answer for the session. A restart pauses and resumes active runs by
itself; do not restart while a node is still editing `src/`.

## Learn from runs, and keep them fast

Review finished runs for lessons: once a day, and after any long run (more than 2 hours) finishes.
For each run, find idle time: a node that sat `waiting` or `running` while its work was done, a wrong
status, a missed notification, a stalled job, a retry loop. Measure it in minutes, name the cause, and
fix the cause in the skill or the dispatcher, not only in the run. Record each lesson in
`agent-spec/<slug>/handoff.md` and, if it is a rule, in this file.

Speed rules for the coordinator:
- Run deterministic work (tests, typecheck, commits, restarts, status reads, file checks) as plain
  commands in the coordinator, not through an agent. Use `dispatch.ts` subcommands for state changes.
- Start every node whose dependencies are done at once. Never wait on a node that does not block the next one.
- Read `state.json` fresh before reporting a status. Keep `run wait --follow` running so a finished node is
  acted on within a minute, not at the next user prompt.
- Check a node's output files before you accept `done`.
- Tests of this skill (`bun skills/orch/tests/run.ts`): after an edit run `run.ts --changed` (fast
  tier plus the tests of the changed files). Before a commit run the fast tier (`run.ts`, under 30 s).
  Run `run.ts --full` once, at the end, in one node. A path-only or doc-only change runs the fast tier only.
  Add `--budget 300` to stop a run at 5 minutes. It prints the files that did not finish; rerun only those.

## Keep the prompt free

The user must be able to keep typing while a run works. Never wait for a node in the foreground. Start the watch in the background (`run wait <run> --follow`, in a loop that restarts it) with the harness's background command, and act when it reports. In opencode use a background shell command: it notifies the session when it ends, so the user can send new questions and tasks in the meantime. The dashboard watchdog (`GET /api/watchdog`) does the deterministic work (start ready nodes, liveness, done checks, retries) without any session.

## Babysitting

Every running run gets a `health:<run-id>` monitor (`run start` starts it; `run health --ensure-monitors` restores lost ones). It runs `run health <run> --json` every 30 s (`settings.health_every_sec`), and records an event only on a change: a node finished, nodes became ready, a node stalled, died, lost its owner or recovered.
- Start every agent with a node and its FULL session id as owner (`--owner ses_…`), never a prefix.
- Run every node that can run, in parallel up to `max_parallel`. `run health` lists `ready` nodes and free `slots`.
- When a node finishes, re-check `ready` at once and start those nodes. React to the monitor's change events (kind `health` in the run's activity feed) instead of polling. Without a monitor, run `run health <run>` every 5–10 min.
- `stalled` (no session activity for 15 min, `ORCH_STALL_MIN`): the monitor nudges opencode sessions (once per node per 30 min; `settings.auto_nudge: false` turns it off; `run health --nudge` does it by hand). If the session stays stalled, respawn the node. `dead`: respawn it. `unowned`: bind an owner or restart the node. `no-report`: read the session and record the result.
- A node added before its deps were known: `node update <run> <node> --after a,b` (or `--after '*'` for a gate that waits on every other node). A node that waits on the user: `node update <run> <node> --needs-user "<reason>"` (`--clear-needs-user` when answered). `run health` then never lists it as ready, and shows it as `needs-user`.
- A ready node you hold back on purpose (for example until load < 4): `node update <run> <node> --hold "<reason>"`. `run health` then never lists it as ready, and shows it as `held`; the card says `held: <reason>`.
- Release the hold: `node update <run> <node> --clear-hold` (setting the node `running` clears it as well). In `node batch`: `"hold":"reason"` / `"clear_hold":true`.
- Never leave a node `running` with no activity. Ask the user only about nodes that truly need them, and keep the rest running meanwhile.

## Coordinator wake-up

`orch run wait <run>` blocks until the run needs you, then prints one line per event and exits 0: a node status change (`a running->done`), `ready: b,c`, `q needs-user: <reason>`, a node `stalled` (no session activity for `--stall-min`, default `settings.stall_minutes` or 15), `dead` (owner session gone), `no-report` (owner idle, node not reported), a dead health monitor (restarted for you), `run ended: <status>`. Exit 3 = nothing running or ready, 124 = `--timeout` passed with no change. A cursor in the run keeps what was already reported, so nothing between two waits is lost and nothing is reported twice. `--json` prints one object per event. Never write your own polling script for this.

Pick the form by what this session can do:
- **Background shell that tells you when a command ends** (opencode, Claude Code background Bash): run `orch run wait <run>` in the background. When it ends, act on the events, then start it again at once.
## Short prompts and shell commands

Start each dispatched or subagent prompt with the one-line preamble in
[references/subagent-preamble.md](references/subagent-preamble.md); do not paste the rules. Use the `workdir`
tool argument instead of `cd`, the edit tool instead of python heredocs, and `scripts/o.ts`,
`scripts/run-nodes.ts`, `scripts/job-tail.ts` instead of inline `jq`/`o(){...}` one-offs.

- **A Monitor tool that streams a command's lines**: monitor `orch run wait <run> --follow` (it ends by itself when the run ends).
- **Neither** (pi and similar): call `orch run wait <run> --timeout 600` once per turn.

After each wake, handle every event (start ready nodes, respawn dead or stalled ones, ask about needs-user), then restart the wait. Stop when it reports `run ended`.

## Work like ultracode

Treat every substantive task as a graph, the way Claude Code's ultracode does: plan, fan out, cross-check, watch.

1. **Plan first.** Before any work: `run start`, then `node add` for every step. Give independent steps no `--after` link between them so they run in parallel. Set `--model` when you know it.
2. **Start and finish live.** `node update <run> <node> running` when work on the node begins, `done` or `error` the moment it ends. Never mark nodes in a batch afterwards: the dashboard duration would read seconds.
3. **Cross-check.** Add a `verify` node (`--role validation`, `--after` the nodes it checks) that reads their out dirs and tests the result. A failed check is an `error` on that node, then retry.
4. **Report what ran inline.** Work done in this session or by a subagent has no job to read usage from. Record it: `orch node report <run> <node> --model M [--input-tokens N] [--output-tokens N] [--cache-read-tokens N] [--usd X]`. Pass only numbers you know.
5. **Fan out.** Prefer dispatched nodes or subagents over doing parallel steps yourself.
6. **Stay free to monitor.** Use `run sync` and `node digest` instead of reading logs, and give the user the `#/run/<run-id>` link when the run starts.

## Delegation workflow

Use this when a strong model should plan and review, and a cheaper model should write the code. The
run keeps the plan, the task list and the review findings in its `delegation` record. The orch session
relies on that record, not on its own context, after the context is trimmed.

Profiles, checked by `orch delegate` (not by convention):

- plan and review: a strong profile, `quality` high or best (template: `claude-default`).
- implement and fix: a profile below that quality (template: `local-llm-fast`).

Steps:

1. Start the run: `orch run start "<title>"` → prints `<run-id>`.
2. Plan: a strong node writes `plan.md` into its out dir. Store it with
   `orch delegate <run-id> plan @<out>/plan.md`, then add one task per unit of work:
   `orch delegate <run-id> task add <id> --stage implement --profile local-llm-fast --label "..."`.
3. Implement: a cheap node per implement task. Set `doing`, then `done`:
   `orch delegate <run-id> task set <id> doing|done`.
4. Review: a strong node runs `cr` and a bug search on the changed files and lists its findings. The
   session records each one: `orch delegate <run-id> finding add <task-id> "<text>"` → prints `F<n>`.
5. Fix: a cheap node per open finding. The session closes each one after the fix:
   `orch delegate <run-id> finding close F<n>`.

Before the session trims its context, run `orch delegate <run-id> show` (or `show --json`). Only what
the run stores survives the trim, so store the plan, tasks and findings before trimming.

Questions: a node sends its question with `orch msg send <run-id> --to orch "<question>"`. The session
reads it with `orch msg read <run-id>`, asks the user through the question tool (see "Asking the user"),
then answers with `orch msg send <run-id> --to <node-id> --from orch "<answer>"`. A subagent returns its
question in its report, and the session asks it the same way.

## Node questions

Nodes never talk to the user. They ask with `node ask`, and the question arrives in the coordinator session (through the herdr bridge, `run wait` or the notify log). The coordinator triages each question: it answers a technical or plan question itself with `node answer <run> <node> <id> "<text>"` and a one-line reason. When the decision belongs to the user (preference, risk, cost, credentials, scope), the coordinator asks the user through the question tool, with one option per node option and a recommended first option, and then relays the choice with `node answer`. The coordinator answers within one turn: an unanswered ask holds a node for up to 600 s.

## Asking the user

Every question to the user goes through the session's question tool (`AskUserQuestion` in Claude
Code, the `question` tool in opencode). This is the default, not an option: a question written as plain
text ends the turn and stalls every parallel node until the user happens to reply.

- Ask the moment a decision is needed, not at the end. Start every node that does not depend on the
  answer first, so work continues while the user answers.
- Group related decisions in one call. Put the recommended option first and label it
  "(Recommended)". Give each option a one-line consequence.
- Plain text is the fallback only where the harness has no question tool, and then it ends with one
  concrete question.
- A question is any ask for an opinion, a choice, a go-ahead or a missing detail, even one you can
  work around. A "Q1, Q2" list, a "needs you" line or "say yes and I will" at the end of a report
  all count: each goes through the question tool, in the turn you first need it.
- Before you send a final message, read its last paragraph. If it asks the user to choose, confirm
  or reply, call the question tool and remove it from the text.
- Never end a turn with a question in prose, and never wait on an answer while ready nodes sit idle.

## Offline mode (dashboard down)

**The CLI is the source of truth.** Every mutation goes through `dispatch.ts` straight to
`~/.harness-orch/` — runs, jobs, profiles, memory and suggestions. If the dashboard server is
down, stopped, or unreachable, **keep orchestrating exactly as above** (`run start`, `node add`,
`node dispatch`, `run sync`, `run finish`, `profile pick`, `memory add`, …). Nothing in Step 3–4
requires the server; only the browser view does.

When the dashboard is offline the user sees a stale page — that is cosmetic. Do not block work on
it. Say once that the CLI path is live and offer `orch sync` when the server is back.

**Check and recover the server** when you need the dashboard or suspect it is why the page is
stale:

```bash
orch serve status              # state=running | down | zombie | stale | unavailable
orch serve recover --start    # default: fix stale/zombie markers and start in background
orch sync                     # recover server (best effort) + run sync on active runs + suggest scan
```

`serve recover` handles the cases it understands: stale pid marker, process alive but not
answering (zombie), skill sources newer than the running server (restart). It cannot fix a
missing `bun` binary (install Bun or set `ORCH_BUN`) or a port already taken by another program —
`serve status` and the last lines of `~/.harness-orch/serve/log` name the cause.

`orch sync` is the catch-up pass after offline CLI work: flips finished jobs on any `running` run,
rescans suggestions, and auto-applies safe memory rows when learning is on. Pass `--no-serve` to
skip dashboard recovery. Run it after `serve recover` succeeds, or periodically if the server was
down for a while.

If a background **service** is installed (`scripts/service.ts status`), a down listener may need
`scripts/service.ts restart` instead of `orch ui` — `ui` and the service must not race for the
port.

## Dashboard

`orch ui` brings up a Bun server on `0.0.0.0:6724` and opens it. One server serves every session
on the machine: if it is already up, `ui` reuses it and just prints the URL; if the skill's
sources are newer than the running process, it restarts it first. `ORCH_NO_OPEN=1` prints the URL
instead of opening a browser (headless or remote shells); `orch ui --stop` shuts the server down.
`orch serve [--host H] [--port P]` runs the same server in the foreground. Both need **bun 1.3+**
— set `ORCH_BUN` to point at a specific binary; a missing bun exits 127.

The main view lists every run, active first; `#/run/<run-id>` shows one run's graph — running
nodes pulse and each box always shows status, attempt, model, duration, usage and role/tier; a value nobody reported reads as a muted placeholder (`model not reported`, `no usage reported`) with the reason in its tooltip. Click a node for
profile, model, job, timings, attempts, error and log tail. `#/profiles` and
`#/memory` edit the two JSON files in place, with the same validation the CLI applies and an
ETag check that refuses to overwrite a change made behind your back. The page polls every 2 s and
shows "updated Ns ago". Give the user the `#/run/<run-id>` link when a run starts.

**Requests from this machine need no token** — the server authorizes any loopback peer, so `ui`
prints a plain `http://127.0.0.1:<port>/` and the page never asks for anything. A request from
any other address still needs the bearer token, which is what the hostname URL carries and what
`~/.harness-orch/serve.token` holds (minted 0600 on first start). Trash that file and restart to
rotate it. `ORCH_REQUIRE_TOKEN=1` demands the token from loopback too.

## Publishing a run as an artifact

`orch artifact <run-id> [--out DIR]` emits a self-contained copy of the dashboard for one run —
`index.html` plus a JS and a CSS chunk — into `DIR` (default `~/.harness-orch/artifacts/<run-id>`).
Every API document the page would fetch is embedded in `index.html` as a
`<script type="application/json">` island, so it renders with **no server and no network**. That
is what makes it publishable as a Claude Code artifact, which has no network access.

Publish all three emitted files together, mapping each to its path in the bundle — the page loads
the JS and CSS by relative path, so an `index.html` published alone renders blank. Then hand the
user the artifact link.

Two things to say when you publish one:

- **It is a snapshot, not a live view.** The run's state is frozen at emit time. Re-run
  `orch artifact` and publish again to refresh it. The header reads "published snapshot — not
  live" so the reader is not misled, and the page does no polling.
- **It carries the profiles, memory and suggestions documents too**, because it is the whole
  dashboard rather than the graph alone. No secrets are in those files — `profiles.json` holds
  env-var *names*, never values — but anyone with the link can read the profile topology: names,
  flags, model ids. Say so before publishing to anywhere shared.

Editing is refused rather than broken: a save in a snapshot answers `405` with "This is a
published snapshot — it has no server to save to." and toasts that message.

## Loops and monitors

Two detached tools for work that repeats or waits. Both run without this session, so they cost no
tokens while they run. Each prints an id.

**Loop:** runs a target every interval, fixed-rate (10s minimum). A slow iteration skips the ticks it
covered. Five failures in a row set the loop to `failed`; failures back off (interval × 2^n, capped at
1 hour) until then. A loop stops by itself after `--max-runtime` (default 24h).

```bash
orch loop start --every 10m --max 20 --until 'gh pr checks 123 --json state | grep -q SUCCESS' \
  --profile claude-default "Check the open PR, fix any failing check"
orch loop list | stop <id> | resume <id> | tail <id> [-n N]
```

Every loop is also an orch run with the loop's id: each tick is a node (`i1`, `i2`, …, the newest 50 kept), the tick's
output is in the node's handoff dir (`output.txt`), and the run closes with the loop (`done` on `--max`, `--until` or the
runtime limit, `error` after five failures, `cancelled` on stop). So the run list, the run graph and `node digest` show
loops like any other work.

`--session` picks what each iteration sees. `fresh` (default) is a new session each tick, so context never
grows. `resume` keeps one session across ticks (claude and copilot targets only). `<id>` resumes a session
you already have, for any target that can resume (opencode: `--session ses_…`). Into a live opencode session,
`--when-idle` is on by default: before each tick orch reads the newest message (a finished assistant message is idle),
waits up to one interval for it to finish, then skips the tick and counts it (`skipped`). Pass `--no-when-idle` to send
regardless. It prints a warning at start, because the prompt lands in a conversation someone may be using. `loop resume <id>` restarts a
`failed`, `stopped` or lost loop with a fresh failure count and runtime limit.

The loop ends on `--max`, when `--until` exits 0, when the agent writes `STOP` to the file named in
its prompt, or on `loop stop`. `--until` runs as your shell command, so quote it like a cron entry.

A loop runs a model each tick. For a pure status check, use a watch (`orch watch start --every 30s "<cmd>"`): it costs no tokens. Never word a loop prompt as "do nothing else" or "just reply OK": the agent may take that as permission to write `STOP` and end the loop early, which already happened. Give a loop real work, and check `orch active` rather than assuming it still runs.

**Monitor (watch):** runs a command and keeps only the lines that matter, as events. The agent reads
events, never the raw log.

```bash
orch watch start --name ci "gh run watch <run-id> --exit-status" --match 'FAIL|Error' --until 'completed'
orch watch start --name api --every 2m "curl -s localhost:8080/health" --match 'down' \
  --on-match "The API is down. Diagnose it." --profile claude-default
orch watch wait <id> --timeout 600 --max-lines 20   # blocks; prints only new events
orch watch events <id> [--since N] | list | stop <id>
```

- `--match` and `--ignore` are ERE (bash `[[ =~ ]]`), applied per line. With `--every`, an event fires
  when the filtered output changes.
- `watch wait` exit codes: 0 new event, 3 ended with no new event, 124 timeout. Each wait moves a
  cursor, so the next wait shows only what it has not shown yet.
- `--on-match` starts one job per event at most every 60s, with the matched lines in its prompt.
- Limits: `--max-runtime` (default 24h), events capped at 2000 characters each, the newest 500 kept,
  scheduled output capped at 10 MB per run, 10 active watches at most. A streaming watch stops its
  source command when it ends.

**Summary:** `orch active` prints one line per running loop or watch, plus any that failed or lost their
process (marked `[failed]` or `[lost]`). `orch active --json` returns the same data. Check it at the
start of a turn, not by polling. The dashboard shows the same data: a header pill on every page and a
"Loops and monitors" strip on the Runs page, from `GET /api/active`, with a Stop button per card
(`POST /api/active/<id>/stop`, after a confirm dialog).

**Restarts:** a loop whose process died (reboot, kill) is restarted by `orch sync`.
Ticks missed while it was down are skipped, and an iteration cut off mid-call is counted and recorded as
`interrupted`. A signal records a watch `stopped`, and one whose process is gone (SIGKILL, reboot, or
its pid reused by another process) is recorded `dead` with the reason and an event by the next
`watch list`, `active`, `watch wait` or `orch sync`. `orch sync` then restarts a scheduled watch that is
still wanted (not stopped by a user, not past `--max-runtime`, and any run named in its command still
running), with a `restarted` event naming why it died. A streaming watch cannot resume mid-stream and
stays dead. `run health --ensure-monitors` recreates a dead `health:<run>` monitor. `orch prune` also
removes ended loops and watches past the retention window.

Without a background shell or a Monitor tool (opencode, pi), the same commands work as written.
Call `watch wait` once per turn instead of a Monitor.

## Schedules

A schedule runs a prompt (through a profile) or a shell command on a cron timetable. Unlike a loop,
it needs no open session: the dashboard server (`scripts/service.ts`) calls `schedule tick` every
30 s and starts whatever is due.

```
orch schedule add --name "morning summary" --cron "0 9 * * 1-5" --profile opencode-smart-auto --prompt @brief.md
orch schedule add --name "pull repo" --cron "*/15 * * * *" --command "git -C ~/repo pull" --workdir ~/repo --timeout 5m
orch schedule list [--json]     # id, on/off, cron, kind, last status, next run
orch schedule show <id>         # full record with the last 30 runs
orch schedule edit <id> [--name N] [--cron C] [--prompt TEXT|@file] [--profile P] [--command CMD] [--workdir DIR] [--timeout DUR]
                                # change only the given fields; history, id and on/off state stay
orch schedule run <id>          # fire now, outside the timetable
orch schedule log <id> [index]  # output of a run, 0 = newest
orch schedule disable|enable|remove <id>
orch schedule next "<cron>"     # check an expression before saving it
```

- Cron: five fields (`m h dom mon dow`) with `*`, lists, ranges and `/step`, or `@hourly @daily @weekly
  @monthly`. Times are the machine's local time. When both day-of-month and day-of-week are set, either
  one matches, as in standard cron.
- A command runs under `bash`, output kept per run, killed at `--timeout` (default 1 h, exit 142).
  A prompt run is a normal `start` job, so it shows in the run list and honours the profile.
- One run at a time per schedule: a tick that finds the previous run still going skips it.
  A time missed while the server was down fires once on the next tick, not once per missed minute.
- State is `<home>/schedules/<id>/schedule.json`. Only `dispatch.ts schedule …` writes it.
- Dashboard: the Schedules page (`#/schedules`) lists them with run history and output, and creates,
  pauses, runs and deletes them (`/api/schedules`). With no server running, nothing fires: use
  `orch schedule tick` from your own cron, or start the service.

### From a chat

A schedule, loop or monitor can belong to a dashboard chat. The result then returns to that chat's thread (`target: {kind: "chat", chat_id, mode}`), the chat list shows an unread dot, and a push with category `Schedules` is sent. The same engines run: `schedule`, `loop` and `watch` of dispatch.ts stay the only writers; the dashboard server adds the part only it can do, which is sending into a chat (`src/server/chats/automation.ts`).

```
orch schedule add --chat <chat-id> [--mode message|fresh] [--tz Asia/Jerusalem] [--once] --name N --cron C --prompt P
orch schedule list --chat <chat-id>
orch loop start --every 10m --max 20 --chat <chat-id> [--mode message|fresh] [--until-re RE] [--until-text TEXT] [--until CMD] [--label L] --profile <chat profile> "<prompt>"
orch loop list --chat <chat-id>
orch watch start --chat <chat-id> --meta '<json>' [--baseline] [--every 60s] [--match RE] --name N "<cmd>"
orch watch list --chat <chat-id>
```

- **Schedules.** `mode: message` (default) sends the prompt into the chat as a user message `Scheduled: <name>` through the normal send path and queue: same session, it waits in the queue while a reply runs and never cuts it. `mode: fresh` runs the prompt in a new one-off session with the chat's folder, harness and effort and posts the final answer as an assistant block `Scheduled result: <name>` with a link. The cron is read in the schedule's own zone (`--tz`, default the machine's; DST: a time that does not exist is skipped, a repeated one fires once). A chat schedule is fired by the dashboard server (claim files make a fire happen once), not by `schedule tick`; `schedule run` refuses it (use `POST /api/chats/{id}/schedules/{sid}/run-now`). A run missed while the server was down fires once on boot inside the grace window (`settings.schedule_grace_hours`, default 6), otherwise it is recorded `skipped`. A failed run retries once after 5 minutes; 3 failures in a row pause it with `pause_reason` and an error notice in the chat. An archived chat pauses its schedules. At least 5 minutes between runs; at most 50 active chat schedules. `schedule record <id> --status ok|failed|skipped ...` is how the server writes a run (single writer).
- **Loops.** The chat's profile runs each iteration; the server posts every iteration into the chat with a quiet counter (`iteration 3 of 10`), then a closing line. Stops on `--max`, `--until` (command exits 0), `--until-re` (regex on the reply), `--until-text` (the agent judges it and writes `STOP`), Stop, or 3 failures in a row (a plain loop allows 5).
- **Monitors.** `--meta` carries `{spec, once, debounce, then}`; `spec.type` is `file`, `url`, `command`, `stream`, `run` or `git`. The check is a shell command the watch engine already runs (cksum for a file or folder, `curl` for a URL, `ghx run list` for CI). `--baseline` skips the first reading so only a change triggers. At most 20 active per chat; at least 10 s between local checks and 60 s for a URL; only http and https URLs, no credentials, and link-local and metadata addresses (169.254.0.0/16, fe80::/10, `metadata.google.internal`) are refused, also after DNS resolution, unless `settings.monitor_allow_link_local` is true. A trigger posts a short message and pushes; `then: {mode: "act", prompt}` also sends that prompt into the chat. `debounce` folds triggers into one message; `once` stops after the first.
- **Chat API.** `GET|POST /api/chats/{id}/schedules|loops|monitors`, `PATCH|DELETE .../schedules/{sid}`, `POST .../{sid}/run-now|pause|resume` (loops: `stop`, `resume`; monitors: `stop`, `pause`, `resume`, `run-now`), `GET .../{sid}/log` (last 20), `POST /api/chats/{id}/read` (clears the unread dot). The global Schedules and Active pages show these items with a Chat column.
- **Agent.** The first turn of a session gets one line: it may suggest a schedule, loop or monitor, must ask the user to confirm, and the user creates it with `/schedule`, `/loop` or `/watch`. No tool lets the agent create one alone.

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
| `copilot` | `copilot` on `PATH` | `copilot -p … --silent [--model M] [flags]` — the template profiles pass `--allow-all-tools --allow-all-paths --allow-all --yolo --no-ask-user --autopilot` |
| `local-llm` | `LLM_HUB_URL` (OpenAI-compatible base); optional `LLM_HUB_MODEL`, `LLM_HUB_TIMEOUT` | POST `$LLM_HUB_V1_URL/chat/completions` |
| `pi` | `pi` on `PATH`, `LLM_HUB_URL`, a model (profile or `LLM_HUB_MODEL`); optional `LLM_HUB_KEY` | `pi --model hub/M --approve --no-session -p … [flags]` with a private agent dir whose `models.json` points provider `hub` at llm-hub `/v1` |

A profile supplies the model, CLI flags and env for its harness (e.g. `claude-llm-hub` points
`ANTHROPIC_BASE_URL` at `${LLM_HUB_URL}`). A missing binary or unset variable fails fast with a
clear message (exit 127 / 1) — report it, do not retry. Contract and how to add one:
[adapter-contract.md](references/adapter-contract.md).

Smart Auto metadata travels per harness. `claude` sends `x-llm-hub-smart-auto-worker`
(`<run>/<node>/<attempt>`), `-parent`, `-role` and `-tier` in `ANTHROPIC_CUSTOM_HEADERS`, keeping any
headers the environment already set. `opencode` sends the same headers through its `hub` provider's
`options.headers`. `copilot` and `pi` cannot send headers: their node records
`metadata_transport: "preset-model"` and `worker_identity: null`, and their `hub/smart-auto-*` model
id moves to the node's tier (`hub/smart-auto-balance` → `hub/smart-auto-fast`).

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
