# Why orch was slow and gave worse results than opencode subagents

Written from one long session (a 200-node orch run, then the same kind of work done with opencode
subagents in the main session). Numbers are measured from the run state, job logs and git history;
times marked "about" are estimates from timestamps. No personal data here: see `local.md` for paths.

## 1. What happened

| Phase | How the work ran | Result |
|---|---|---|
| Orch run, about 12 h, 200 nodes | herdr panes, one opencode job per node, engine + watchdog + health + owner binding, handoff files, coordinator answers asks | 181 nodes done, 23 retried, 4 in error, $80 total (96 percent on smart-auto nodes), median node 745 s, median node queue 15 s, median ask latency 702 s, 145 of 181 done nodes without a handoff file |
| Bun port with orch nodes (Haiku), about 3 h | 15 nodes with `after` edges | 5 nodes finished, several ended early, asked the user in text, or were marked "stuck starting" while working |
| Same port with 13 subagents in git worktrees, about 1 h | one subagent per lib group, I merged the branches | about 11,400 lines of bash ported, 90 bash tests replaced, 12 merges with conflicts resolved, no run of the code yet (user rule: tests once at the end) |

The subagent phase finished more work in about 1 h than the orch phase did in about 3 h for the same
task family. The first full run of the subagent result then found 58 failing test cases and 9 failing
bun tests, so speed was not free: the code was unverified.

## 2. Anatomy of one unit of work

Orch node (measured or read from code):
1. Engine sees a ready node (fs event, 200 ms debounce).
2. `dispatch.sh node dispatch` runs: about 90 process starts, 7 s wall under load (bash and jq).
3. A herdr workspace, tab and pane are created, a launcher script starts opencode: cold start 6 to 10 s.
4. The agent works. Its only inputs are the prompt built from the node goal and a rules header.
5. It writes a handoff, the process exits, the runner records the exit code.
6. Watchdog, health map, owner binding and selection fill poll the job and the session database,
   each through more `dispatch.sh` calls, to fill model, cost, effort and status.
7. The coordinator reads asks and answers them, usually minutes later.

Subagent (opencode task tool):
1. The parent writes one precise prompt (the whole brief, files, rules, acceptance).
2. The subagent starts in the same process tree, no pane, no launcher, no state machine.
3. It works. The parent can follow up in the same session, so a correction costs seconds.
4. The final message comes back as the tool result. Nothing polls.

So an orch node adds control-plane work in steps 2, 3, 6 and 7, and removes the live supervisor.

## 3. Root causes, ranked by cost

1. **No live supervisor in the loop.** A node is an autonomous opencode job. When it ends its turn
   early (text-only message), the process exits and the node turns "done" with nothing delivered.
   145 of 181 done nodes had no handoff. A subagent that stops early is re-prompted by its parent
   at once. This is the largest quality gap and also a time sink: a 40 minute attempt can be lost.
2. **Slow human-speed feedback path.** Asks went to a coordinator that answered when it noticed
   (median 702 s). Agents time out after about 120 s in the shell tool, so waiting for an answer
   killed turns. Subagents ask the parent directly, or just decide.
3. **Process-spawn cost of the bash core.** 7 s per `dispatch.sh` call (about 90 process starts at
   80 ms or more each under security scanning and load 20 to 35). A node does dozens of calls.
4. **False positives from supervision.** "stuck starting", "stalled", "lost" and duplicate-start
   guards fired on healthy nodes (pid-owned jobs with no owner events), set nodes to error and
   triggered retries and duplicate jobs (12 jobs for one node in minutes). Each layer was added to
   fix the previous layer's blind spot and added its own.
5. **Shared working tree.** Nodes edited the same checkout. One unfinished edit (a missing entry in a
   lib list) broke every `dispatch.sh` call for everyone. Subagents worked in separate worktrees and
   merged afterwards.
6. **Weak briefs.** The engine built prompts from a short goal. The subagent prompts were written
   with files, rules, constraints and decisions already made (which options to take, what not to
   touch), so they did not need to ask.
7. **Model choice.** Cheap models ended turns, asked in text, or lost the thread on long tasks;
   smart-auto was unpredictable and expensive (96 percent of cost). Subagents ran on one steady
   model chosen per task.
8. **Tests inside nodes.** Full bash suites of 8 to 12 minutes ran several times in one node.
9. **Machine load 20 to 35.** Every extra node multiplied process starts and slowed all others.
   More parallelism was not faster past a point.

## 4. Why the results were worse, not only slower

- "Done" meant "process exited with code 0", not "acceptance met". There was no output verification.
- Work was lost on retry: a retry restarted from the goal, not from the previous attempt's progress.
- Several nodes finished their code but left the tree broken for others (shared tree).
- Questions arrived late or never, so nodes guessed or stopped.
- Status was stale or wrong in the UI (false errors, stale flags), so decisions were made on bad data.

## 5. Where orch is still better

- A run outlives a session: pause, resume, restart recovery, scheduled work.
- Visibility: one page with every node, status, model, cost and tokens, events and handoffs.
- A model per task and a cost per node, which a subagent call does not record.
- Isolation of context: a node sees only its brief, which saves tokens in the main session.
- An audit trail (state, events, handoffs) that a chat session does not keep.

## 6. What to build so orch is as fast as subagents

1. **Supervise nodes like a parent would.** Resume the same session on early end with a "continue"
   message, verify the output files and checks before accepting done, retry from the last progress.
2. **Fast, cheap control plane.** One Bun process per command, a long-lived server for hot paths,
   no jq or bash in the loop (the port in this repo does this).
3. **Warm agents.** Keep opencode servers running and attach a node as a session. Remove the
   per-node cold start and pane creation for small tasks.
4. **Hybrid routing.** Small or mechanical tasks run as in-session subagents (still recorded in the
   run for cost and visibility); large or long ones run as nodes.
5. **Answers without a human.** Auto-answer from the plan and recorded decisions, escalate to the
   user only for preferences, risk and scope. Never block a node for more than 90 s.
6. **Worktree per code node** with merge on green, and a smoke check before any merge.
7. **Brief generator.** Build each node prompt from the plan: files, decisions, acceptance, last
   handoffs of dependencies, and the rules, not from a one-line goal.
8. **Load-aware scheduling.** Cap parallel nodes by load and finish started nodes first.
9. **Tests in the engine, not in the agent:** touched tests per node, fast tier before merge, full
   suite once, all in-process and parallel.

## 7. Decision rule

Use a subagent when the task fits in one prompt, finishes in under about 30 minutes, edits files in
its own worktree and needs no later audit. Use an orch node when the work must survive a session,
needs a pinned model or cost cap, needs visibility to other people, or runs unattended.

## 8. Open questions to measure (use the method in SKILL.md section 4)

- Overhead per node after the Bun core and warm agents: target under 20 percent of node time.
- Early-end rate with resume-on-early-end: target under 5 percent.
- Success rate by model and task kind, to train the cost router.
- Whether the brief generator removes most asks.
