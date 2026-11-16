---
name: unorch
description: (BN) Take an orch run over into the main session. Stops the run from starting more nodes, prints one report of every unfinished node (status, goal, waiting-on, error, job liveness, last log lines, handoff, pending asks), and then the main session does the open work itself in dependency order. Use when the user wants to stop using orch nodes, nodes keep failing or getting stuck, or says "grab all the nodes to this session". Triggers: "unorch", "stop using orch", "grab the nodes", "do the stuck nodes here".
---

# unorch

Orch nodes can stall, end early or ask questions nobody answers. `unorch` moves the work to the main session so it finishes without them.

## Step 1: Grab the status (one command)

```
bun <orch-skill repo>/scripts/unorch.ts [run-id]   # repo: /Users/barnu/sandbox/private/orch-skill
```

- Without a run id it takes the newest running run.
- It sets `auto_dispatch false` and pauses the run, so no node starts behind your back. Running agents are not killed. `--no-pause` prints the report only.
- The report lists every unfinished node: status, profile, goal, unmet dependencies, error, job liveness (ALIVE or dead), the last log lines, handoff path, and the node's pending asks.
- It also writes the takeover record as markdown, the source of truth for the whole takeover, in `agent-spec/unorch/<run>/` of the repo:
  - `tasks.md`: one checkbox per node with its status, handoff link and a `| notes:` field (owner, branch, state). Done nodes are checked. A re-run keeps your checked boxes and notes.
  - `handoffs/<node>.md`: a copy of every node handoff, so the main session reads them in one place.
  - `asks.md`: every node ask and whether it is answered.
- Manage the work through these files: write the branch or subagent that owns a task in its `notes`, tick `[x]` when it is merged, and re-run the script to refresh statuses and handoffs.

## Step 2: Order the work

1. Read each report entry. A node with a live job and a growing log is still working: leave it, or ask the user whether to cancel it (`dispatch.ts node cancel <run> <node>`), before you touch its files.
2. For a stuck or errored node, read its handoff and `git status` for the files it already changed. Finish from there, not from scratch.
3. Do the nodes in dependency order (the report prints `waiting on`). Independent nodes can run in parallel through subagents of the main session, never through orch.

## Step 3: Do the work here

- Parallel work: for each independent task, make a git worktree and branch (`git worktree add -b take-<task> ../<repo>-take-<task> master`), start one subagent of the main session in it (never an orch node), and tell it the rules: work only in that worktree, commit on its branch, no push, no question tool. Record the branch in `tasks.md`.
- Tests: when the user wants speed, subagents run no tests. The main session merges the branches, resolves conflicts (usually `cli.ts`, `PORTED_COMMANDS` and similar lists), and runs every test once at the end, with a 5 minute cap per call and `--resume` after exit 75.

- Follow the repo rules (`CLAUDE.md`): touched tests only, a 5 minute cap, commit by path, no push, restart the service after a `src/` change.
- Answer a node's pending ask yourself when you take its work over. Ask the user only for a user decision, through the question tool.
- After each task: merge its branch, tick its box in `tasks.md`, commit its files, and record it with `dispatch.ts node update <run> <node> done --force` and a handoff written into the node's out folder (`runs/<run>/out/<node>/handoff.md`), so the run page and `run status` stay true.

## Step 4: Close

- When no node is left, run `dispatch.ts run finish <run>`.
- To hand the run back to orch: `dispatch.ts run resume <run>` and `dispatch.ts run set <run> auto_dispatch true`.
