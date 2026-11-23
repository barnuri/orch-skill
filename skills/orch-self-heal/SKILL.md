---
name: orch-self-heal
description: >
  Recover stuck or failed orch runs. Read run status, let the supervisor act, read its actions,
  and handle only flags that need an orchestrator. Use when a run is stuck, a node failed, or the
  user asks to recover runs. Triggers: "recover my runs", "the run is stuck", "node failed",
  "orch-self-heal".
allowed-tools: Read, Bash
---

# orch-self-heal

Use the orch run ledger as the source of truth. Use `dispatch.ts` for every state change.

## Inspect

1. Find active runs with `run list`.
2. Read one run with `run status <run> --fresh`.
3. Read requirements with `req list <run>`.
4. Note `error`, `running` without activity, `unverified`, `blocked-user`, and open requirements without active nodes.

## Let the supervisor act

5. Check the dashboard service with `scripts/service.ts status`.
6. Wait for one supervisor interval. Do not repeat a retry while the supervisor is acting.
7. Read recent actions from `~/.harness-orch/watchdog/actions.log`.

## Recover

8. A live job PID always wins. Never restart it.
9. Read test failures from the node handoff and bounded job log.
10. Fix the cause, then retry with a changed continuation prompt when a session can be resumed.
11. If a handoff is missing, synthesize it from the final transcript and continue the missing work as a partial recovery node.
12. Create a node for every open requirement or missing gap. Run independent recovery nodes in parallel.
13. Set `blocked-user` only for a real user decision, credential, approval or destructive action.
14. Do not force-finish a run with open requirements.

## Verify

15. Record evidence and a result for every recovered node.
16. Run `run verify <run>` and finish only when it passes.
17. Report one line per affected node: failure, supervisor/manual action, and new status.
