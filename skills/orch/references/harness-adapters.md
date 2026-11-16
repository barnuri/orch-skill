# Harness adapters: owner events

A node's owner (`--owner agent ses_...`) can tell orch when it finishes. Both adapters call the
harness-neutral `orch owner event <id> <started|alive|finished|failed> [--note ..] [--harness ..]`.
It looks up `<home>/owners/<id>.json` (written when a node is set running with an owner) and ignores
unknown ids. A `finished` event sets the node `done` with `auto`, `unverified` and
`reported_by: owner-event:<harness>`: a finished owner is not a reviewed result.
`dispatch.ts` stores its own path in `<home>/.dispatch-path` (on `init` and on every `node update --owner`).

## opencode: `mods/opencode/orch-nodes.js`, linked to `~/.config/opencode/plugins/orch-nodes.js`
- `install.ts` links it (`scripts/install-opencode-plugin.ts`; a real file there is kept as `.orch-backup-<epoch>`).
- `session.idle` -> finished, `session.error` -> failed, `session.status` busy/retry -> alive (at most every 30 s).
- Checks the registry file first. A session that is not an orch worker spawns nothing.
- Inbox: after a tool call, when `runs/<run>/inbox/<node>/` holds a pending message (at most one look per
  5 s), runs `node inbox <run> <node> --json --via plugin` and appends the messages to the tool result.
  The node is the registry entry, else `ORCH_RUN_ID`/`ORCH_NODE_ID` of a dispatched opencode process.
- Usage: counts `tool.<name>`, `skill.<name>` and `subagent.<type>` per call and writes them with one
  `node usage --add` call on `session.idle` or every 30 s.
- Loads on the next opencode start. Undo: move the link away.
- Test: `bun test src/server/runs/orch-nodes-plugin.test.ts`.

## Claude Code: `SubagentStop` hook
- Script: `/Users/barnu/sandbox/private/skills/hooks/orch-owner-event.sh` (beside the other hooks), registered in `/Users/barnu/sandbox/private/skills/claude-user-scope/settings.json`.
- Reads the payload (`agent_id`, `session_id`, `last_assistant_message`), calls `owner event ... finished --harness claude`.
- Backup before the edit: `claude-user-scope/settings.json.orch-backup-<epoch>`. Undo: copy it back over `settings.json`.
- `~/.claude/settings.json` is a regular file here (not a symlink) and was not touched.
- Test: `bash /Users/barnu/sandbox/private/skills/hooks/orch-owner-event.test.sh`.

## Owner binding and autofill

When a coordinator gives free-text owners ("agent ses_x (spawned)", or none), `node bind-owners` finds the session: (a) an id inside the text, (b) `<home>/owners/pending/<child>.json` written by the opencode plugin on `session.created` of a child of a running run's session (`{child, parent, title, created, created_ms}`; matched by title words, then by start time within -60 s/+180 s, closest wins, a tie stays unbound), (c) opencode `GET /api/session?parentID=<run.harness_session>`. Failure sets `owner_state: unbound` and `owner_reason`; no owner for 2 min (`ORCH_UNOWNED_SECS`) sets `unowned`. A bound session fills only empty `model`, `report` tokens/usd, `harness` and `last_activity` (`GET /api/session/<id>`), at most 5 nodes per pass. Switches: `ORCH_OWNER_BIND=0`, `ORCH_OWNER_FILL=0`, `ORCH_OWNER_BIND_SECS` (throttle, default 20). The plugin also sends `owner event <id> started` once, when the binding exists.
