# Shared subagent rules

A coordinator points each dispatched prompt at this file instead of repeating the rules.
Every node agent follows all of them.

1. Do not run `git commit`, `git push`, `git stash`, `git checkout` or `git reset`.
2. Do not delete with `rm`. Use `trash`.
3. Use `ghx`, never `gh`.
4. Never write under `~/.harness-orch` (the orch home). Change orch state only through `dispatch.sh`
   subcommands, and write your handoff into `$ORCH_NODE_OUT`.
5. Do not restart the dashboard service (`service.sh restart`, `dispatch.sh ui`).
6. Run only the tests of the files you touched. Never run the full suite (`tests/run.sh --full`, `bun run test`, `test-all.sh`): it runs once, in the `final-gate-full` node, after the test speed-up nodes are done. Any test command that runs longer than 5 minutes is stopped at 5 minutes (`timeout 300`, or `--budget 300` once it exists) and continued, not waited on; if it was cut, run only the remaining files. A path-only or doc-only change needs no test run beyond a syntax check.
7. Keep calling tools until the task is done. Do not stop to ask when you can decide.
8. Keep the final report to 6 lines or fewer: what changed, test result, files.
