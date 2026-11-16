# Chat design plan

Scope: the one chat page (dashboard `AppShell` and chat-only `ChatShell`). CSS first. The look lives in
`src/web/chats/chat-design.css`, imported last in `src/web/styles.css`, so feature work in `chats.css`
and the other chat stylesheets keeps its class names. Tokens come from `src/snapshot/tokens.css`.

## Audit (before, 1280x800 and 375x812, dark and light)

Screenshots: `$TMPDIR/chat-design/before-*.png`. The ten biggest problems:

| # | Problem | Cause |
|---|---|---|
| 1 | Hebrew user text has the wrong base direction: the full stop lands at the left, the quoted word flips. | `.user-text` has no `dir=auto`; the page is LTR. |
| 2 | Hebrew assistant text, list numbers and mixed lines sit on the wrong side and ragged. | `.md` blocks have no per-block direction. |
| 3 | At 375px the composer overflows: the Send button is off-screen, the "Last reply failed" badge is clipped. | `.composer` is a grid with an implicit `auto` column, so `.composer-row` and `.chat-settings` keep their content width. |
| 4 | The user message is a saturated blue bubble. Blue means live or primary action only. | `.msg-user .bubble` uses `--accs` and `--accb`. |
| 5 | Assistant text, tool rows and the foot start at three different offsets. | Patch rules at the end of `chats.css` (`.msg:not(.msg-user) .bubble` twice, `.tool-row`, `.msg-foot`). |
| 6 | Body text is 14px with line height 1.45, in an 820px column: too dense for long answers. | `.bubble`, `.thread-inner`. |
| 7 | Every reply has a loud foot: speaker button, Copy, Regenerate, model, time. | `.msg-foot`, `.msg-speak`. |
| 8 | The composer is a full-width bar with a border and four flat buttons; it reads as a form footer. | `.composer`, `.composer-row`. |
| 9 | The header stacks four lines of meta (about 120px on a phone), and the sidebar uses uppercase group labels. | `.chat-head`, `.chat-session-note`, `.group-head`. |
| 10 | Tables are fully boxed grids, code blocks and scrollbars are default, nothing is hover-revealed, physical `left` and `right` are used in many rules. | `.md table`, `.thread-scroll`, `.tool-row`, `.thread-actions`, `.jump-pill`. |

## Colours (all tokens)

| Name | Token | Job |
|---|---|---|
| Canvas | `--bg` | Thread background. |
| Card | `--panel`, `--raised` | Composer card, menus, header. |
| Quiet tint | `--inset` | User block, code, tool bodies. |
| Ink | `--tx`, `--tx1` | Reading text. `--tx2` and `--tx3` for meta. |
| Signal | `--acc`, `--acct`, `--accs` | Send, links, selected row, focus. Live and primary only. |
| Status | `--status-*` trios | Tool state, errors, warnings. Red is error only. |

## Type and rhythm

- Sans `--font-sans` (Geist, system fallback for Hebrew), mono `--font-mono` for code, ids, durations.
- Reading text `--fs-read` 15px / `--lh-read` 1.65. Meta 12px. Code 13px / 1.55. Headings 600, 16-18px.
- Spacing on the 4px scale (`--s1`..`--s7`). Between messages `--s5`; between blocks inside an answer `--s3`.
- Reading column `--measure` 760px, centered. Prose wraps with `text-wrap: pretty`.

## Layout

- Assistant text: no bubble, no border, flush to the column start edge.
- User message: a tinted block (`--inset`, 1px `--border`, radius `--r-xl`), max 85% of the column, aligned to the start. Text uses `unicode-bidi: plaintext` and `dir=auto`.
- No avatars: role is told by the block (tinted) and the foot, so avatars add nothing.
- Tool cards and reasoning: one quiet row, 12px, 2px start rule, tone only on state.
- Code: always LTR, inset surface, 6px radius, thin scrollbar. Tables: hairline ledger, no vertical rules, scrolls inside its own box.
- Scroll: thin themed scrollbar, `overscroll-behavior: contain`, `scrollbar-gutter: stable`; the jump-to-latest pill sits at the inline end above the composer.
- Composer: a floating card (`--panel`, `--border-strong`, `--shadow`, radius `--r-xl`) inside the column; the textarea auto-grows to 200px; Send is the one filled button; Stop uses the amber danger style already in `.btn.danger`.
- No layout shift while streaming: the live cursor is an inline pseudo element with fixed width; foot actions keep their space (opacity, not display).
- Empty state: title 600 and one sentence. Loading: neutral text rows. Error: inline notice (existing `ErrorNotice`).

## Wireframes

Desktop (LTR; in RTL everything mirrors, the sidebar moves to the right edge):

```
+-----------+--------------------------------------------------+
| Chats  [<]| Fix the flaky schedule test  ✎       [ws] [Arch] |
| [New chat]+--------------------------------------------------+
| search    |                                                  |
|           |        ┌───────────────────────────┐             |
| orch-skill|        │ Why does the test fail?   │  user block |
| ▌Fix flaky|        └───────────────────────────┘             |
|  Deploy   |        The test races on the clock. The ticker   |
|  Long ans |        claims `<next_at>` ...      assistant text|
|           |        ┌ code (ltr) ───────────────┐             |
|           |        └───────────────────────────┘             |
|           |        copy · regenerate (on hover)   [↓ Latest]  |
|           |   ┌────────────────────────────────────────┐     |
|           |   │ Message…                         🎤  ➤ │ card|
|           |   └────────────────────────────────────────┘     |
+-----------+--------------------------------------------------+
```

Phone (375px, sidebar is a drawer from the inline start):

```
+-----------------------+
| ☰  Fix the flaky test ✎|
+-----------------------+
| ┌───────────────────┐ |
| │ user block        │ |
| └───────────────────┘ |
| Assistant text, 15px  |
| full width            |
|              [↓ Latest]|
| ┌───────────────────┐ |
| │ Message…  🎤  ➤   │ |
| └───────────────────┘ |
+-----------------------+  safe-area inset below
```

## The one bold move, the one accessory removed

- Bold move: the composer as a floating card with the only filled button on the page.
- Removed: the per-reply meta chips (model, tokens, cost, time) and the speaker button are hidden until hover or focus (shown on touch); Copy and Regenerate stay, quiet. No avatars, no header dividers inside the thread.

## Rules for RTL

Logical properties only; `dir=auto` or `unicode-bidi: plaintext` on message text, list items, headings, table cells; code and tool output `direction: ltr`; chevron and arrow glyphs mirror under `[dir="rtl"]`.
