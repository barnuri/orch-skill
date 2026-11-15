# Recommendation

**Pick Direction B "Signal".** Look at `shots/B-runs-1280-dark.png`, `B-chats-1280-dark.png`, `B-profiles-1280-dark.png` against the A shots.

## Why
1. **R1 The user's own decision.** The decisions log says a token-and-shell pass is too subtle and layouts and components must change ("more makeover"). A changes layout in the run page only; B changes the shell, run page, chat and lists.
2. **R2 It matches the product.** Runs, chats and schedules are things in flight. One left tree with dot + mono model + age (Orca, Poracode) shows all of them at once and removes the 7-link top nav that clips at 375px (audit F6).
3. **R3 It fixes the audit.** Chat pickers move into the composer (F8), the node inspector replaces the below-the-fold details (F7, F12), and the stale/running/done colours get separate meanings (F3, F17).
4. **R4 Lower risk than it looks.** Same token names, same 17 bank components (3 restyled heavily), prototypes already pass 4.5:1 text contrast and 3:1 control edges.

## Where A is better
A costs about half the work (no new shell), keeps the Plex fonts (no new bundle) and the blue the user already knows. Choose A if the work must land in one agent-day.

## Risks of B
- **Blue accent.** B keeps the original blue accent and blue-slate surfaces; only layout and type are new. Running (blue) and the accent share a hue, so running always shows a word.
- **Rail on mobile** is a drawer: one tap more than a tab bar. A bottom tab bar can be added to B (A's TabBar) without touching tokens.
- **Geist adds 69KB** of fonts (6 woff2) and replaces Plex, which the log recorded as accepted ("keep Plex").

## Questions you must answer
1. **Q1** Is the log entry "keep IBM Plex" still binding? If yes, B switches to Plex Sans/Mono (token change only) and the type choice becomes neutral.
2. **Q2** Resolved: B ships with the original blue accent (the lime was dropped).
3. **Q3** Left rail on desktop, or keep the top bar and only borrow B's graph and chat designs?
4. **Q4** Mobile: drawer for the workbench, or a bottom tab bar (Runs, Chats, Profiles, More)?
5. **Q5** Run page: right inspector (B) or detail row below the graph (A)?
6. **Q6** Keep the 4 KPI tiles on Runs? Both directions remove them.

Nothing was appended to the ui-design skill files; record the answers in `references/decisions.md` after you choose.
