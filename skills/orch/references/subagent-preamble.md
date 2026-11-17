# Standard subagent preamble

Coordinators paste this one line at the top of a dispatched prompt (or a Task/subagent prompt) instead of
repeating repo, rule and reporting boilerplate. Fill the `<...>` parts; add only task-specific facts after it.

```
Repo <abs path> (<branch>). Read CLAUDE.md and skills/orch/references/agent-rules.md first; follow them. Task <node-id>: <goal>. Deadline <N> min. Handoff into $ORCH_NODE_OUT.
```

Put in the task text only what differs from `agent-rules.md`:

- Commit permission ("commit by path, no push") when the node may commit. The default is no commit.
- Files other nodes edit at the same time ("do not touch X, re-read before each edit").
- The exact test files to run.

Do not restate: no `rm`/use `trash`, no `gh`, no hand edits under `~/.harness-orch`, no service restart,
no question tool, report length, test budget. `agent-rules.md` already says all of these.

## Shell habits (all agents)

- Pass the `workdir` tool argument. Do not start a command with `cd <repo> &&`.
- Edit files with the edit tool, not a `python3 - <<'EOF' ... s.replace(...)` heredoc.
- Use the repo scripts instead of inline `jq`/`ls -td`/`o(){...}` one-offs:

| Need | Command |
|---|---|
| Call dispatch.ts on the real home, `@run` = current run | `bun scripts/o.ts node inbox @run <node> --unread` |
| Set many nodes to one status | `bun scripts/o.ts set done a b c` |
| Node status by group / open nodes / running ids | `bun scripts/run-nodes.ts [run] [--open\|--running\|--status s\|--json]` |
| Newest job, a job prefix, or a node's job: exit code and log tail | `bun scripts/job-tail.ts [prefix\|--node id] [--bytes N]` |

The run id defaults to `$ORCH_RUN_ID`, then `/tmp/orch-run-id`, then the newest running run.
