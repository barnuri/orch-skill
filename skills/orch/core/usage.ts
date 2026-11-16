// Usage text printed by `dispatch.ts -h` and for an unknown subcommand.
export const USAGE = `dispatch.ts classify "<task description>" [--complexity trivial|small|medium|large] [--prefer-local]
    -> prints exactly one of: claude-native | local-llm | cursor-agent | opencode | copilot

dispatch.ts announce [--clear|--dry-run|--quiet|--run <id>|--ttl-sec N]
    -> shows running orch work in Herdr and the status line (see references/status-bridge.md).
       Mutating run/node commands call it automatically in the background.

dispatch.ts budget-check
    -> exit 0 = safe to route more work to Claude Code; exit 1 = avoid (near limit).
       Reason printed to stderr either way.

dispatch.ts run   (--profile <name> | <adapter>) <prompt-or-@file> [pass-through args...]
    -> runs synchronously in the foreground. Exits with the harness's own exit code.
dispatch.ts start (--profile <name> | <adapter>) <prompt-or-@file> [pass-through args...]
    -> self-backgrounds (nohup), prints a job-id to stdout immediately, exits 0.
       When herdr is installed (and ORCH_HERDR is not 0) the job runs in a pane of the orch skill's
       own headless herdr instance (never your live session; one tab per run), same log and exit
       file. If that instance cannot start, or has 20 panes, the job starts detached as before.
       adapters: claude-native | claude | cursor-agent | opencode | local-llm | copilot | pi
       --profile supplies harness + model + flags + env from profiles.json instead of <adapter>.

dispatch.ts status <job-id>       -> prints "running" | "done exit=<n>"
dispatch.ts tail <job-id> [-n N]  -> prints the last N (default 20) log lines
dispatch.ts wait <job-id> [--timeout SECS(default 300)] [--interval SECS(default 5)]
    -> polls status until done or timeout; exit 0 if finished, 124 on timeout.
dispatch.ts list                  -> job-id, status, profile — newest first.

dispatch.ts init                  -> creates the config home (default ~/.harness-orch) with template
                                     profiles.json + empty memory.json; prints the path.
dispatch.ts profile list          -> name, harness, model per profile (* = default)
dispatch.ts profile show <name>   -> the profile JSON as written (env refs unresolved)
dispatch.ts profile pick "<task>" [--complexity trivial|small|medium|large] [--kind K]
    -> profile=…, model=…, reason=… (metadata + memory weighted pick)
dispatch.ts profile sanity [--profile NAME]
    -> JSON {generated_at, results:[{profile, ok, ms, harness, model_id, slug, exit_code, bytes, error}]}
dispatch.ts profile unset-env <name> <VAR>...
    -> drops the named env vars from one profile; the rest of profiles.json stays as written
dispatch.ts model list [--profile P] [--harness H]
dispatch.ts harness list [--json]
    -> probes each adapter (CLI on PATH or env for local-llm); JSON includes enabled flag
       from settings.disabled_harnesses.
    -> model-id, slug, description, cost, quality (whitelist when --profile is set)
dispatch.ts demo seed | reset | advance [--run <id>]
    -> seeds (or clears) mock runs, DAGs and job transcripts for the dashboard. Never spawns a
       harness. Refuses the default state dir without --force: point HARNESS_ORCH_HOME at a
       scratch dir instead. \`advance\` steps one seeded run forward, for recordings.

dispatch.ts suggest scan | list [--pending] | apply <id> | dismiss <id>
    -> learning loop: scan runs/memory, surface pending suggestions, apply/dismiss

Loops and watches (detached; each prints an id; \`active\` summarizes all running ones):
dispatch.ts loop start --every <dur> [--max N] [--until CMD] (--profile P | <adapter>) <prompt|@file> [args...]
dispatch.ts loop list | stop <id> | tail <id> [-n N]
dispatch.ts watch start --name N "<cmd>" [--match RE] [--ignore RE] [--until RE] [--every DUR] [--on-match PROMPT --profile P]
dispatch.ts watch wait <id> [--timeout S] [--max-lines N] [--since N] | events <id> | list | stop <id>
dispatch.ts active [--json]
    -> one line per running loop or watch; --json for harnesses and the dashboard

Schedules (cron; each fires a prompt through a profile, or a shell command; the dashboard server ticks them):
dispatch.ts schedule add --name N --cron "<m h dom mon dow>" (--prompt TEXT|@file --profile P [--model M] | --command CMD [--workdir DIR] [--timeout DUR])
dispatch.ts schedule edit <id> [--name N] [--cron C] [--prompt TEXT|@file] [--profile P] [--model M] [--command CMD] [--workdir DIR] [--timeout DUR]
    -> changes only the given fields; keeps id, created_at, enabled and run history; --prompt/--command switch the kind
dispatch.ts schedule list [--json] | show <id> | enable <id> | disable <id> | remove <id> | run <id> | log <id> [index] | tick | next "<cron>"
dispatch.ts herdr on|off|auto|status|attach|ensure|stop|sweep | herdr health [--json] [--nudge]
`;
