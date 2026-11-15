# Reference products: what to learn (ideas only, no branding)

Sources: READMEs and docs fetched with `ghx api` (`research/readme-orca.md`, `readme-Poracode.md`, `readme-openwork.md`), plus `docs/STYLEGUIDE.md` of Orca. Images in `research/refs/`: `orca-hero.jpg`, `poracode-hero.png`, `openwork-app.png`, `openwork-model-picker.png`.

## Orca (stablyai/orca): coordinator and workers
- **L1 Navigation model.** One left sidebar groups Projects > worktree > agent threads. Each row is a live thread with a status dot, model tag in mono (`opus-5.5`) and age (`49m`). No top nav. Search, Tasks, Automations sit above the tree. Fits orch: runs and chats are the same "thing in flight".
- **L2 Status density.** Bottom bar shows per-agent usage meters and reset times (`42% 2h 48m · 59% 4d 6h`). Orch can show queue slots and quota the same way.
- **L3 Chat composer.** Rounded card: placeholder with hints ("Ask anything, @ to mention files, / for commands"), toolbar row `+`, permission chip ("Full access"), model chip, mic, round send button at the end edge. Picker state is in the composer, not in a header.
- **L4 Orchestration in chat.** Coordinator messages contain collapsible event rows: "Started worker tax-rules ↗ 3:02 PM v", "Update from worker". Tool calls are one-line rows ("Read CHANGELOG.md", "Edited CHANGELOG.md +6"). Prose has no bubble.
- **L5 Mobile.** The phone app mirrors the thread: tab strip of worker threads under the title, same composer docked at the bottom.
- **L6 Rules (STYLEGUIDE.md).** Monochrome chrome, colour only for state; three elevation levels (hairline, hairline+shadow-xs, floating); sans is Geist, mono for anything literal; 14/13/12/11px scale; category labels 11px uppercase tracking-wider; `primary` only for the one affirmative action. Matches our taste rules.

## Poracode (Porabuild/Poracode): panes of threads
- **L7 Sidebar.** Home, "New thread" per project, thread rows with a provider glyph, branch-style name (`feat/auth-refactor`), age on the right and a diff stat (`+21`). Usage rings at the bottom. Schedules is a first-class sidebar item (we have it).
- **L8 Split layout.** Several threads side by side, each with its own header (name, project, icons) and its own composer. Orch can offer "pin two chats side by side" later, not now.
- **L9 Composer picker row.** Under the text: provider mark + model with chevron, effort bars, flag and permission icons, `+`, branch, mic, send. Everything is an icon-sized control with a tooltip. Row stays one line.
- **L10 Plan card above the composer.** "Plan 2/4" checklist with the active step highlighted. Orch equivalent: the current run's node progress pinned above a run-linked chat.
- **L11 Tool rows.** `Create refresh.ts src/auth +96`, `Edit session.ts +48 -12`, `Run pnpm test auth 5.4s`: verb, mono target, path dimmed, diff green/red. Dense and scannable.
- **L12 Inline question card.** "ROLLOUT / Put the middleware swap behind a flag? / Yes, gate it": small caps label, one question, choices. Useful for orch "needs you" nodes.

## OpenWork (different-ai/openwork): the picker and the quiet shell
- **L13 Model picker.** Popover under the composer: search field, groups Pinned / Recent / per provider, provider glyph + name + provider label, check on the selected row, footer "Effort  Default  ^T" and "Connect more providers / All models". Copy the grouping and the keyboard hint, not the pastel look.
- **L14 Composer.** Placeholder "Describe your task...", toolbar `attach | Build v | model v | Balanced v` and a disabled-looking "Run task" primary until text exists. Mode, model, effort in one row.
- **L15 Shell.** Left list of workspaces/sessions (search with `Cmd Shift F` hint), conversation in the centre, a right panel that hosts files/browser, and a thin right icon strip. Session tabs sit above the conversation with split and close icons.
- **L16 Status.** One bottom line: green dot "Ready for new tasks", Docs, Feedback, settings. Nothing else.

## What we copy
1. Left workbench tree of live things with dot, mono model, age (L1, L7).
2. Composer with the picker row inside the card (L3, L9, L14).
3. Grouped searchable model picker (L13).
4. One-line tool rows and worker/event rows instead of bubbles (L4, L11).
5. Usage meters as the footer of the shell (L2, L7).

## What we do not copy
Pastel gradients and wallpaper backdrops (OpenWork, Orca marketing), emoji-like provider logos (we draw neutral letter marks), and the mobile-as-separate-app model.
