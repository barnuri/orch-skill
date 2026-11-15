# Component bank changes

The 17 React components in `src/web/components/`. "Token only" = restyles with `tokens.X.css`, no code change. Both directions need the same new `--edge` token on inputs, and a status component (below).

| Component | A | B |
|---|---|---|
| Button | token only; add `sm` size (28px) and `icon` size; 44px under coarse pointer | same, radius 6px, primary = blue accent, add `ghost` |
| Checkbox | token only, edge uses `--edge` | same |
| Chip | add removable variant (x) for attachments and picker chips; 28px, 36px coarse | same, picker chip gets a harness mark slot |
| ConfirmDialog | token only | same |
| Countdown | token only (mono, tabular) | same |
| EmptyState | centre it, 600 title + one sentence + 1-2 actions; drop dashed box | same |
| HarnessMark | token only; marks use `--mark-*` with `--bg` letter | same; used in rail rows and picker rows |
| IconButton | 36px, 44px coarse; remove the border for header buttons (ghost) | same |
| KpiTile | **remove from Runs.** Keep the component for Memory/Settings if used, else delete | same |
| PageHead | title + count + actions on one row, wraps on mobile | lives in the top bar of the shell |
| Panel | token only, radius 12 (A) | radius 10, hairline |
| RunStrip | replace chips with the hairline strip (labels micro, values mono) | `facts` row of mono text + two status pills |
| Segmented | token only; add `aria-pressed` states as in prototype | same |
| Select | custom popover (done), `--edge` border | same; add search and group headers for model picker |
| Skeleton | same height as the real row (52px A, 48px B) | same |
| Toast | one sentence, no title | same |
| Toggle | 34x20, 44x26 coarse | same |

## New components needed
1. **StatusPill** (both). `ok|run|er|wa|pu|mute`: dot + word, trio from tokens, pulse only for `run`. Replaces inline `.pill` markup.
2. **GraphNode** (both). Card (A: 3px start rail; B: 3px top bar) with mark, title, status pill, two mono rows. Selected = accent ring. Replaces the vanilla canvas card.
3. **Composer** (both). Attachment chips row, textarea, picker row (harness, profile, model chips), attach and send buttons. Mobile: picker row scrolls with end fade. Exists in pieces in `src/web/chats/Composer.tsx` and `Pickers.tsx`.
4. **ModelPicker** (B first, A later). Popover: search, Pinned/Recent/group headings, check on selected, effort footer (idea L13).
5. **ToolRow** (both). One line: verb, mono target, dim path, right-aligned result. Replaces markdown tool blocks in `MessageView.tsx`.
6. **TabBar** (A). 4 items + More, 60px, safe-area padding.
7. **WorkbenchRail** (B). Search, grouped tree (Runs, Chats) with `TreeRow` (dot, title, age, mono sub), nav, usage meters. Collapses to a 56px icon rail then a drawer.
8. **Inspector** (B). Right panel for the selected node; bottom section on mobile.
9. **Ledger** (both). Hairline row table with sticky header, 3-state rows (list, skeleton, empty, error), toggle in last column; mobile reflows to 2 lines.
