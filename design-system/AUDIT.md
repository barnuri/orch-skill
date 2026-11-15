# UI audit: current dashboard (vanilla `/`) and React app (`/next`)

Evidence: `shots/audit/<page>-<width>-<theme>.png`. Prefix `old-` = vanilla at `/`, `new-` = React at `/next`. Pages: runs, run-graph, profiles, schedules, harnesses (old and new), chats and chat-conversation (new only). Widths 1280 and 375, themes dark and light. Seed: temp home with a 4-node run (plan done, implement running, tests error, review waiting) and a second run. At audit time `/next` Runs is a placeholder ("Not ported yet"), so the run graph is audited on the vanilla UI.

## Ranked problems

### Accessibility
1. **F1 Weight 500 is declared but not bundled.** `components.css` uses `font-weight: 500` (buttons, pills, tabs). `fonts.css` ships Plex Sans/Mono 400 and 600 only, so 500 is a synthesized fallback. Fix: bundle 500 or drop it.
2. **F2 Input edges are below 3:1.** `--border-strong` on `--panel` is 2.1:1 light and 1.9:1 dark (WCAG 1.4.11 needs 3:1 for control boundaries). Both new directions add `--edge` (3.2-3.5:1).
3. **F3 Red is used for "stale".** `new-chat-conversation-1280-dark.png`: the Live dot is red with "87s ago". Red means error only (taste R4). Use amber for stale.
4. **F4 Status mix.** `--ok` and `--wa` are close in dark on small pills; the run progress bar (old-runs) separates running/error/done by hue only, with no legend or text on the bar.

### Touch and mobile
5. **F5 Header controls are 44px, nav pills 32px.** `old-runs-375-*`: refresh and theme buttons are 44px square next to 32px pills. Wrong hierarchy, and the pills are below 44px touch.
6. **F6 Nav overflows with no cue.** At 375 the tab row clips at "Me…" (Memory). No fade, no "More". The user cannot tell that Schedules/Memory/Suggestions exist.
7. **F7 Run view on mobile is a chip wall.** `old-run-graph-375-light.png`: 8 meta chips stack in 7 rows before the graph starts at y=440. The graph panel is 280px tall and clips both sides. The graph is the product, and it is below the fold.
8. **F8 Chat pickers are hidden on mobile.** `new-chat-conversation-375-dark.png`: harness/profile/model sit behind a menu glyph. On desktop they take a 130px block above the messages and are labeled "fixed after the first message" three times.
9. **F9 Page scrolls are not styled uniformly.** Several `overflow:auto` areas show no edge fade (run graph canvas, log tail).

### Density and hierarchy
10. **F10 KPI tiles carry no data.** `old-runs-1280-light.png`: four 100px tiles show 2, 0, 0, 0 with the "big number, small label" pattern. A single inline strip holds the same facts in 40px.
11. **F11 Run status contradicts nodes.** The run row reads "running" while one node is in error (blue "running" pill, red segment in the bar). Show "running · 1 error" as one pill pair.
12. **F12 Graph node text.** `old-run-graph-1280-dark.png`: titles are cut ("Implement token ex…"), the orch root node draws its icon over the "pid-61939" label, "unowned · 1m ago" and "after the fact" in amber bold read as warnings on healthy nodes, and stage headers are uppercase (taste: uppercase only for short pills).
13. **F13 Empty states are left-aligned dashed boxes.** `new-schedules-1280-dark.png`: 1100px of empty page below a 130px box. The sentence names the fix, which is good. The layout wastes the page.
14. **F14 Chat bubbles.** User and assistant bubbles share a border and near-equal surfaces (`new-chat-conversation-1280-dark.png`). Assistant text sits in a bubble, tool calls are not shown, and the cost line is raw mono with no grouping.

### Consistency
15. **F15 Two shells.** Vanilla nav has no Chats; React nav has it. Header on `/next` placeholder says "waiting for server…" while the page works.
16. **F16 Card styles vary.** Harness cards use a 3px left rail with a radius-xl card; profiles are a hairline list; schedules are a dashed box; runs are rows with a left rail. Four list idioms for the same job.
17. **F17 Primary button on dark.** `--onacc` is near-black on `#3d8bfd` (6.4:1, fine) but the same blue is used for primary, selected pill, running status and links, so "blue" has four meanings.

## What to keep
Token architecture (`light-dark()`, status trios, one file), skip link, `Segmented`, toggles, reduced-motion handling, the status-rail idea on rows and nodes.
