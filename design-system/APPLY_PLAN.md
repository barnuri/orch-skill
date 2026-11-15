# Apply plan (after the React migration lands)

Precondition: the vanilla `src/dashboard/` UI is retired and `src/web/` owns every page including Runs. Until then the tokens file is shared (`src/web/styles.css` imports `../dashboard/styles.css`), so step 1 is safe to land alone. Visual makeover goes in its own commit, separate from code fixes, and is committed only after the user says it looks good (decisions log).

Steps. Each step ends with: typecheck, `bun test`, screenshots at 1280 and 375 in both themes, then a service restart (repo CLAUDE.md).

| # | Step | Agent | Owns (only these files) | Depends |
|---|---|---|---|---|
| 1 | Tokens + fonts: replace `tokens.css` with the chosen file, add font files and `@font-face`, add Sans 500 (A) or Geist set (B) | agent-1 | `src/web/tokens.css` (moved), `src/web/fonts.css`, `src/web/fonts/*` | none |
| 2 | Bank primitives: Button, IconButton, Chip (removable), Segmented, Select (search/groups), Toggle, Checkbox, EmptyState, Skeleton, Toast; add StatusPill | agent-2 | `src/web/components/*` | 1 |
| 3 | Shell: A = Header + TabBar; B = WorkbenchRail + top bar + drawer; 44px targets, `--nav-h` | agent-3 | `src/web/shell/*`, `src/web/styles.css`, `src/web/router/*` | 2 |
| 4 | Runs + graph: GraphNode, Inspector (B) or detail row (A), RunStrip/facts, mobile vertical graph | agent-4 | `src/web/pages/Runs*`, `src/web/runs/*`, `components/RunStrip.tsx` | 2, 3 |
| 5 | Chats: Composer, ModelPicker, ToolRow, thread list/tree, mobile docked composer | agent-5 | `src/web/chats/*` | 2, 3 |
| 6 | Profiles + Harnesses + Schedules: Ledger, states | agent-6 | `src/web/pages/Profiles*`, `Harnesses*`, `Schedules*`, `forms/*` | 2, 3 |
| 7 | Memory, Suggestions, Settings, ConfirmDialog sweep, scrollbar and focus audit | agent-7 | `src/web/pages/Memory*`, `Suggestions*`, `Settings*` | 2, 3 |
| 8 | Review: checklist from taste.md (contrast script, no raw colour grep, 375 overflow, reduced motion) | reviewer | read-only; findings only | 4-7 |

Parallelism: 1 then 2 then 3 are serial (about 3 agent-hours). 4, 5, 6, 7 run in parallel after 3 because each owns separate files. Step 4 and 5 are the largest.

Checks that must pass before a commit: `python3 design-system/contrast.py src/web/tokens.css` prints worst >= 4.5; `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(" src/web --include=*.css --include=*.tsx` finds only the tokens file; no inline `style=` in static markup (CSP `style-src 'self'`; React inline style props are allowed by the existing build only if already used, so prefer classes).
