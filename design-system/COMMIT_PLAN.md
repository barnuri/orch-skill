# Commit plan (planning only, nothing run)

Base: HEAD cc6f3b0 on master, 435 paths. Style of `git log`: sentence case, imperative, no prefix, no trailing period
("Add the chat backend, orch run visibility and the run reconciler on the server"). No push, no co-author line.
Pathspec files go in `$TMPDIR/orch-commits/NN-name.txt` (one path per line); groups below are the full lists.
Because many agents are still writing, **re-run `git status --porcelain -uall` before each commit** and diff against these lists.

Before each commit: `git reset -q` is NOT allowed to disturb others' work, so use
`git restore --staged .` only if the user agrees; otherwise commit with `git commit --only`-style
(`git commit -m ... -- $(cat list)`) which ignores other staged paths. The script below uses
`git commit --pathspec-from-file=LIST --only` for that reason (renames: list BOTH old and new path, see 01).

Verify order for every commit: `bash scripts/typecheck.sh` (must print `typecheck: ok`) -> scoped tests -> commit.
Whole tree is shared, so typecheck of an intermediate commit only means something if checked out clean
(`git stash` is banned: use `git worktree add $TMPDIR/chk <sha>` after committing, run there; optional).

## Never commit / delete-candidates (do not add)
- `    1405` (file literally named with 4 leading spaces + `1405`, content `homes     1327 -`): accidental shell redirect `> 1405` leftover. Do NOT commit; ask user to delete (no `rm` for me).
- `design-system/__pycache__/contrast.cpython-313.pyc`: staged, a build artefact. Unstage (`git restore --staged`) and add `__pycache__/` to .gitignore.
- `config` symlink: already gitignored (`/config`), leave.
- `.playwright-cli/` is newly ignored (.gitignore +1): that line goes in commit 00.
- Binaries >300 KB: none found. No .env, node_modules, or screenshots among the 435 paths.
- Leftover-looking: `design-system/proto/*` (HTML prototypes, gen.py) and `design-system/research/*` are staged scratch; keep only in the docs commit if the user wants them (see 09), else omit.
- `src/snapshot/fonts/ibm-plex-*.woff2` are duplicated in `design-system/fonts/` (rename staged from src/dashboard/fonts): fine, but Plex copies exist twice.
- Excluded, other session: all `mods/orch-graph/**` (6 modified files). Never stage.

## Group 00 - housekeeping (independent)  `.gitignore`, `bun.lock`, `package.json`, `tsconfig.json`, `scripts/typecheck.sh`
Check `git diff HEAD package.json bun.lock`: if the new deps are used only by the React app, move these into 01 (they must be with 01 for 01 to typecheck). Recommended: fold into 01. Keep `.gitignore` alone with a message "Ignore the playwright-cli scratch folder" (independent).
`CLAUDE.md` (+32/-10): mixes repo-notes for React swap (01) and restart rules (06). Commit with 01 unless it mentions the restart-safety; then `git add -p CLAUDE.md` and split.

## 01 (a) React app + snapshot split  - HOLD nothing, but depends on 00 deps. Index already holds it (staged "checkpoint 2").
Message: `Move the dashboard to a React 19 app in src/web and keep src/dashboard as the src/snapshot renderer`
Paths:
- all `src/dashboard/** -> src/snapshot/**` renames and `src/dashboard/src/dom/format.ts -> src/web/lib/format.ts` (the deletion `src/dashboard/src/graph/node-meta.test.ts` too)
- all `src/web/**` that are `A`/`AM` EXCEPT the visual files listed in 08
- `src/snapshot/src/**` new files (focus-target, follow-view, node-metrics, node-flags, run-activity, refresh-plan, run-events, live-clock, format.ts)
- `src/snapshot/{components,fonts,styles,tokens}.css` : `RM`/`M` = unstaged edits on top of renames. Split: rename part here; the token/Geist changes go to 08 (`git add -p`, hunks touching font-family, `--font-*`, Geist, tokens).
- `package.json bun.lock tsconfig.json scripts/typecheck.sh .gitignore CLAUDE.md` (from 00)
- `src/shared/dto/{chats,runs}.ts`, `src/shared/types/run-node.ts` only if the web code imports the new fields; otherwise 02.
Mixed files (the `AM` in `src/web`: staged part is the checkpoint, the worktree `M` is later work). The unstaged hunks need classification:
- `src/web/runs/GraphSvg.tsx`: 3 hunks, three agents: (i) Hide-done / waiting-on nodes -> 01 or 02(b), (ii) activity tooltip -> 05 (uses owner-activity / run-activity), (iii) `stale` class -> 05(e) (stale indicator). `git add -p src/web/runs/GraphSvg.tsx`: answer y for the Hide-done hunk, n for the rest; then repeat per commit. Same for `RunPage.tsx`, `RunsPage.tsx`, `GraphViewport.tsx`, `runs.test.tsx`.
- `src/web/shell/{AppShell,Header}.tsx`: build banner/Rail hunks -> 05 (BuildBanner) or 08 (Rail); `src/web/api/{client,token}.ts(+test)`: status/liveness client hunks -> 02.
- `src/web/chats/*` (`ChatsPage`, `ChatView`, `Composer`, `Pickers`, `ProjectView`, `Sidebar`, tests): the harness-disabled and opencode hunks -> 04; CSS hunks (`chats.css`) -> 08.
- `src/web/lib/{chat-logic,node-flags,session-state.test}.ts(x)`: split per above. `src/web/pages/*Page.tsx` and `router/route.ts`, `test/dom.ts`, `components/{ConfirmDialog,Toast}.tsx`, `styles.css`: functional hunks here, style-only hunks (class/token renames) -> 08.
Verify: typecheck; `bun test --timeout 300000 --parallel=6 src/web src/snapshot`.
Script:
```
# git commit --only --pathspec-from-file=$L/01-react.txt -m "Move the dashboard to a React 19 app in src/web and keep src/dashboard as the src/snapshot renderer"
```
(renames: commit the whole index state for those paths; `--only` with renamed paths requires the old path in the list as well.)

## 02 (b) status / owner liveness, owner autofill  (needs 01 for the web part; server part independent)
Message: `Show owner liveness and autofill the owner on runs and nodes`
- `skills/orch/scripts/lib/runs/owners.sh` (new), `skills/orch/tests/runs/owner-bind.test.sh`, `liveness.test.sh`, `skills/orch/references/status-bridge.md`
- `src/server/runs/owner-activity.ts`, `owner-activity.test.ts`, `owner-liveness.test.ts`, `src/server/runs/orch-nodes-plugin.test.ts`, `src/server/runs/run-reconciler.ts`, `src/server/active/active-reader.test.ts`, `src/server/routes/active-routes.ts`
- `src/shared/dto/runs.ts`, `src/shared/types/run-node.ts`, `src/server/api/controllers/runs.controller.ts`, `src/server/routes/runs-routes.ts(+test)`, `src/server/artifact/*`
- web: `src/web/lib/owner-activity.ts` and `src/web/lib/{run-activity,node-flags}.*`, `src/web/runs/RunActivity.tsx`, `NodePanel.tsx`, `node-activity.test.tsx`
- Mixed: `skills/orch/scripts/dispatch.sh` (75 lines) and `lib/runs/runs.sh` (about 20 hunks: node add/update status, owner, sync). Hunks for owner/liveness here; lock hunks -> 03; herdr hunks -> wait (06). `git add -p`.
Verify: typecheck; `bash skills/orch/tests/run.sh owner`, `... liveness`; `bun test src/server/runs src/server/active src/server/routes`.

## 03 (c) announce daemon, locks, profiles tmp fix, suggest.sh one pass  (independent of the web)
Message: `Add the announce daemon and run locks, fix the profiles tmp file and make suggest scan in one pass`
- `skills/orch/scripts/announce.sh`, `announce.test.sh`, `announce-daemon.test.sh`, `lib/core/locks.sh`, `profiles-tmp.test.sh`, `tmp-leak.test.sh`, `lib/dashboard/suggest.sh`, `src/server/suggest/scan-cache.ts(+test)`, `src/server/routes/suggestions-routes.ts`, `lib/core/config.sh` (profiles tmp fix, 48 lines)
- mixed: `dispatch.sh` (announce/lock hunks), `lib/runs/runs.sh` (lock hunks), `lib/adapters/adapters.sh`, `lib/adapters/hub.sh`, `lib/dashboard/serve.sh`, `SKILL.md` + `references/{state-and-config,adapter-contract,lessons}.md` (split the doc hunks by topic).
Verify: `bash skills/orch/tests/run.sh announce`, `locks`, `profiles-tmp`, `tmp-leak`, `suggest`; typecheck.

## 04 (d) chats: harness-disabled fix, opencode session
Message: `Fix chats on a disabled harness and add the opencode chat session`
- `src/server/chats/**` (`options.ts`, `service.ts(+test)`, `store.ts(+test)`, `sessions/{claude-session,turn-session,types}.ts`, new `sessions/opencode-session.ts`, `sessions/turn-files.ts`, `opencode-session.test.ts`, `chat-resume.test.ts`, `chats-api.test.ts`, `model-offer.test.ts`, `turn-session.test.ts`, `testing/fake-opencode-json.sh`, `testing/fake-claude-slow.sh`)
- `src/server/api/controllers/chats.controller.ts`, `src/shared/dto/chats.ts`, `src/server/routes/harnesses-routes.ts(+test)`, `harnesses-cache.test.ts`, `src/web/pages/HarnessesPage.tsx`, `harnesses.test.ts`
- WAIT: `src/server/chats/restart-safety.test.ts`, `testing/restart-probe.ts`, `testing/fake-dispatch-{load,tree}.sh` (chat turns + restart still being written) -> 06. Mixed: `service.ts` and `turn-session.ts` (opencode vs restart hunks): `git add -p`.
Verify: `bun test src/server/chats src/server/routes`.

## 05 (e) stale-service indicator + restart endpoint
Message: `Show a stale-service banner and add the restart endpoint`
- `src/server/build/{build-service.ts,restart.ts,build-service.test.ts,build-route.test.ts}`, `src/server/api/controllers/build.controller.ts`, `src/server/dispatch-path.ts`, `src/shared/{build-commands.ts,dto/build.ts,types/build-info.ts}`, `src/server/api/build-api.ts`, `src/server/api/api.test.ts`, `src/server/app.ts`, `src/web/shell/{BuildBanner.tsx,use-build.ts,build-banner.test.tsx}`
- `src/web/shell/build-banner.css` -> 08 (or here if kept functional; recommend 08). Mixed: `AppShell.tsx` (banner hunk here, Rail hunk to 08), `GraphSvg.tsx` stale-class hunk. Depends on 01.
Verify: typecheck; `bun test src/server/build src/server/api src/web/shell`.

## 06 (f) restart safety  - PARTLY WAIT
Message: `Keep schedules, chats and the service safe across a restart`
- Ready: `scripts/service.sh`, `src/server/schedules/ticker.ts`, `ticker.test.ts`, `schedule-reader.test.ts`, `routes/schedule-routes.ts(+test)`, `skills/orch/tests/dashboard/service-restart.test.sh`, `schedules-service.test.sh`, `design-system/RESTART_SAFETY.md` (move to docs or keep)
- WAIT (agents writing): `lib/adapters/herdr.sh` (243 lines), `herdr-runner.test.sh`, `references/herdr.md`, `identity-panes-stop.test.sh`, `src/server/chats/restart-safety.test.ts`, `testing/restart-probe.ts`, chat-turn files from 04.
Verify: `bash skills/orch/tests/run.sh service`, `schedules`; `bun test src/server/schedules`.

## 07 (g) tests infrastructure (independent; commit FIRST of the shell ones if tests of 02/03 need it)
Message: `Split the bash test suite into parallel files and add a shared fake dispatch and temp home`
- `skills/orch/tests/run.sh` (runner), `test-lib.sh`, `scripts/test-all.sh`, split files: `carry, classify-adapters, cost-digest, demo-seeding, init-profiles, llm-hub-native, loops-watches, planned-runs, record, routing-claude, run-lifecycle, serve-ui, visibility`.test.sh, `lib/runs/carry.sh`, `lib/runs/visibility.sh` (these two are product code: check, if so into 03), `src/server/test-support/{fake-dispatch.sh,temp-home.ts}`
- Order: 07 before 02/03/06 (their tests reference test-lib.sh); can commit independently.
Verify: `bash skills/orch/tests/run.sh` (0 failed), `bash scripts/typecheck.sh`.

## 08 (h) visual makeover - HOLD until user says it looks good. Own commit, last of the code.
Message: `Restyle the dashboard with the B tokens, Geist fonts and a shell rail`
- `src/snapshot/{tokens,fonts,styles,components}.css` (worktree hunks), `src/snapshot/fonts/GEIST-OFL.txt`, `src/snapshot/fonts/geist-*.woff2` (6, untracked)
- `src/web/styles.css`, `src/web/shell/{shell.css,Rail.tsx,NavIcons.tsx,build-banner.css}`, `src/web/components/overlays.css`, `src/web/pages/{pages.css,pages-b.css}`, `src/web/runs/runs.css`, `src/web/chats/chats.css`
- Mixed hunks (style parts of `AppShell/Header/*Page.tsx`, status-token class names in `GraphSvg.tsx`). Do `git add -p` for these; this is the only commit that must contain them.
Verify: typecheck; `bun test src/web`; user approval first.

## 09 (i) design-system docs (independent; may go before 08 if only docs)
Message: `Add the design-system audit, directions and recommendation docs`
- `design-system/{README,AUDIT,APPLY_PLAN,COMPONENTS,DIRECTIONS,RECOMMENDATION,REFERENCES,RESTART_SAFETY,COMMIT_PLAN}.md`, `contrast.py`, `tokens.A.css`, `tokens.B.css` (AM: re-add), `fonts/**` (Geist + Plex, 14 files), `research/**`, `proto/**` (optional)
- Note: `design-system/fonts/geist-*` pair with 08's fonts; `tokens.B.css` is the source of 08, so commit 09 BEFORE 08.

## 10 Everything else
- `skills/orch/references/{harness-adapters,herdr,lessons,status-bridge}.md`: attach to the group that owns the feature (herdr -> 06 wait; status-bridge -> 02; harness-adapters -> 04; lessons -> 03).
- `skills/orch/SKILL.md`, `references/state-and-config.md`, `adapter-contract.md`: split by hunk across 02/03/06.

## Suggested order
00 gitignore -> 07 tests infra -> 01 React app -> 09 docs -> 03 -> 02 -> 04 -> 05 -> 06 (after agents finish) -> 08 (after approval).
01 is the largest and already staged; keep staged state intact by committing others via `--only`.

## Script (commented, do not run unprompted)
```bash
# L=$TMPDIR/orch-commits; mkdir -p $L   # fill each NN-*.txt from the lists above
# gate() { bash scripts/typecheck.sh && bash skills/orch/tests/run.sh "$1" && bun test --timeout 300000 --parallel=6 "$2"; }
# --- 00
# printf '.gitignore\n' > $L/00.txt
# git commit --only --pathspec-from-file=$L/00.txt -m "Ignore the playwright-cli scratch folder"
# --- 07
# gate '' src/server/test-support
# git commit --only --pathspec-from-file=$L/07.txt -m "Split the bash test suite into parallel files and add a shared fake dispatch and temp home"
# --- 01 (git add -p the mixed AM files first; then)
# gate '' src/web
# git commit --only --pathspec-from-file=$L/01.txt -m "Move the dashboard to a React 19 app in src/web and keep src/dashboard as the src/snapshot renderer"
# --- 09
# git commit --only --pathspec-from-file=$L/09.txt -m "Add the design-system audit, directions and recommendation docs"
# --- 03
# gate 'announce' src/server/suggest
# git commit --only --pathspec-from-file=$L/03.txt -m "Add the announce daemon and run locks, fix the profiles tmp file and make suggest scan in one pass"
# --- 02
# gate 'liveness' src/server/runs
# git commit --only --pathspec-from-file=$L/02.txt -m "Show owner liveness and autofill the owner on runs and nodes"
# --- 04
# gate '' src/server/chats
# git commit --only --pathspec-from-file=$L/04.txt -m "Fix chats on a disabled harness and add the opencode chat session"
# --- 05
# gate '' src/server/build
# git commit --only --pathspec-from-file=$L/05.txt -m "Show a stale-service banner and add the restart endpoint"
# --- 06 (WAIT for herdr runner and chat turns)
# gate 'service' src/server/schedules
# git commit --only --pathspec-from-file=$L/06.txt -m "Keep schedules, chats and the service safe across a restart"
# --- 08 HOLD: only after the user says it looks good
# git commit --only --pathspec-from-file=$L/08.txt -m "Restyle the dashboard with the B tokens, Geist fonts and a shell rail"
# After 01..08: bash scripts/service.sh restart && bash scripts/service.sh status
# NEVER: git push, --author/Co-authored-by, git add -A, mods/orch-graph, "    1405", __pycache__.
```
Caveat: lists are built from status names and a few diffs; hunk assignment inside mixed files was not read line by line, so confirm with `git add -p` previews.
