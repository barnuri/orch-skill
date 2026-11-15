# Two design directions

Both follow the user's taste file: dark-first, dense, tokens only, `light-dark()`, status trios with a dot and a word, custom controls and scrollbars, no generic tells. Both replace `src/dashboard/tokens.css` with the same token names (`tokens.A.css`, `tokens.B.css`) plus new ones: `--raised`, `--edge`, `--lh-tight/body/prose`, `--s7`, `--touch`, `--touch-coarse`, `--nav-h` (B also `--rail-w`, `--rail-w-collapsed`). Contrast tables: `research/contrast-A.txt`, `research/contrast-B.txt` (script `contrast.py`; every text and status-on-tint pair; worst case A 4.72:1, B 4.53:1, all pass 4.5:1).

uux searches used (`research/`): `--design-system "developer tools orchestrator dark dense dashboard agents"`, `--domain color "dark developer dashboard"` (took: code-dark with run-green accent idea, slate surfaces), `--domain typography "developer tool technical dense"` (took: IBM Plex + mono pairing for A; the JetBrains Mono pairing was rejected, Geist Mono chosen for B because Orca uses Geist and it bundles smaller), `--domain ux "touch targets focus contrast"` (took: 44px touch, 3:1 control edges, visible focus). The `--design-system` Pattern section is a landing page pattern and was ignored, as the ui-design skill says.

---
## Direction A "Evolved Plex"

**Concept.** Orch is an orchestrator: a run is a graph of agent nodes, a schedule starts runs, a chat is one agent thread. A keeps today's top-bar shell, Plex type and blue accent, and fixes what the audit found: the graph becomes the hero of the run page, 4 KPI tiles and 8 meta chips collapse into one hairline strip, status is always dot + word, every touch target reaches 44px on mobile, and mobile gets a bottom tab bar instead of a clipped scroller.

- **Bold move:** the run graph is the first thing under the title (strip is 48px), nodes are rail-coloured cards with real names, and the running edge is a flowing dashed line.
- **Accessory removed:** the KPI tile row and the uppercase stage labels.

**Colors** (light / dark; contrast = text on `--panel`, light / dark)

| Name | Job | Light | Dark | Contrast |
|---|---|---|---|---|
| Ink Slate | surfaces bg/panel/inset | `#f3f5f8` / `#fff` | `#0a0c10` / `#11141a` | n/a |
| Ink | text (tx, tx2, tx3) | `#121620` `#525b69` `#59626f` | `#e9ecf1` `#a0a8b6` `#8e97a6` | tx 18.1/15.6, tx2 6.9/7.7, tx3 6.2/6.3 |
| Signal Blue | accent, primary, selected, links | `#1957c7` (text `#164fb4`) | `#4f95ff` (text `#86b5ff`) | acct 7.5/8.8, onacc on acc 6.5/6.4 |
| Run Green | ok / done | `#0b6e45` | `#3ddc97` | on tint 5.3/8.3 |
| Stuck Amber | waiting, slow, stale | `#8a5700` | `#f2b53f` | on tint 5.1/8.1 |
| Fail Red | error only | `#b42323` | `#ff7b7b` | on tint 5.4/6.2 |
Purple `--pu` stays for cancelled/planning. Blue means one thing: "selected or running". Links use the same blue.

**Type.** IBM Plex Sans (400/500/600) + IBM Plex Mono (400/600). Already bundled under `src/dashboard/fonts` (OFL, Latin subset), needs the missing Sans 500 file (`fonts/ibm-plex-sans-latin-500-normal.woff2`, 24KB). `@font-face` urls are relative, same-origin, so `font-src 'self' data:` holds. Scale 11/12/13/14/16/20/28, line heights 1.25/1.45/1.6. Mono for every id, count, model, time. Uppercase only inside pills, none for labels.

**Scale.** Space 4/8/12/16/24/32/48. Radius 4/6/8/10/12/pill (one per role: 10 cards, 6 controls, pill status). Shadow: floating layers only (`--shadow`). Borders `--border`, control edge `--edge` (3:1).

**Motion.** 120ms colour/background transitions; one orchestrated moment: graph edges flow (1s linear loop, running edge only); live dot pulse 2s; row flash 2.4s on new rows. Everything off under `prefers-reduced-motion`.

**Wireframes**
```
RUNS/GRAPH desktop 1280                          RUNS/GRAPH mobile 375
+----------------------------------------------+  +---------------------------+
| orch (Runs)(Chats) Profiles ..  Live  [R] [o]|  | orch          Live  [R] [o]|
| Migrate auth to OIDC (Running)   [Retry][Stop]|  | Migrate auth to OIDC       |
| Run|Started|Elapsed|Nodes 1/4|Running 1|Err 1 |  | (Running)  [Retry][Stop]   |
| [Follow live][-][Fit][+]      3 stages       |  | Run  | Started            |
| Stage1      Stage2            Stage3         |  | Nodes| Elapsed            |
| [Plan ok]=+=[Implement run]=+=[Review wait]  |  | .-[Plan        Done  ]    |
|            +=[Write tests ERR]              |  | .-[Implement   Running]    |
| Node detail            | Log tail            |  | .-[Write tests Error  ]    |
+----------------------------------------------+  | .-[Review      Waiting]    |
                                                  |  Log tail                  |
CHAT desktop                                      | Runs Chats Profiles More   |
+--------+-------------------------------------+  +---------------------------+
|[New]   | Title              [Project][Archive]|  CHAT mobile
|search  |           (user bubble, accent tint) |  | orch      Live [R][o]      |
|threads | tool row: Read state.json   0.2s     |  | Title [Project][Archive]   |
| active | assistant prose (no bubble)          |  | ...messages...             |
|        | done claude-sonnet 4.1s $0.01        |  | +---------------------+    |
|        | [state.json x]                       |  | | [state.json 38KB x] |    |
|        | Message...                           |  | | Message...          |    |
|        | [+] [Claude][profile][model]  (send) |  | | [+][Claude v][prof..|    |
+--------+-------------------------------------+  | +---------------------+    |
                                                  | Runs Chats Profiles More   |
```
Screens: `proto/A-runs.html`, `A-chats.html`, `A-profiles.html` (+ `-empty`, `-loading`, `-error`). Shots: `shots/A-*`.

---
## Direction B "Signal"

**Concept.** Orchestrating agents is watching many things in flight. B drops the tab bar for one left workbench (idea L1 from Orca/Poracode): runs and chats are one list of live rows (dot, title, mono model, age), with Profiles/Harnesses/Schedules/Memory below and usage meters at the foot. The run page is a dotted canvas plus a right inspector for the selected node. The accent is signal lime and means exactly "live, or the one primary action". Done is mint, so lime and done never share a meaning.

- **Bold move:** the workbench rail (one tree for runs and chats with live status) plus a node inspector panel, replacing the top nav and the node-details block.
- **Accessory removed:** the top navigation pills, KPI tiles, and every stage/section label in uppercase.

**Colors**

| Name | Job | Light | Dark | Contrast (on panel, L / D) |
|---|---|---|---|---|
| Green Slate | surfaces | `#eff3f1` / `#fbfcfb` | `#090d0e` / `#0f1517` | n/a |
| Ink | text tx, tx2, tx3 | `#0f1a1a` `#4b5b5e` `#516368` | `#e8efed` `#9aaaa7` `#86989a` | tx 17.3/15.8, tx2 6.9/7.6, tx3 6.1/6.1 |
| Signal Lime | accent, primary, live | `#3d6a0a` (text `#325a06`) | `#b6ef4a` (text `#c6f56e`) | acct 7.9/14.6, onacc on acc 6.4/13.8 |
| Mint | ok / done | `#0a6f5f` | `#35dcc0` | on tint 4.9/8.2 |
| Amber | waiting, stale | `#8c5600` | `#ffb547` | 4.9/8.2 |
| Coral Red | error only | `#b9232f` | `#ff7a7f` | 4.9/6.1 |
Focus ring is blue (`#0b5ed7` / `#8fd0ff`) so it never reads as "live". Light-mode lime is an olive green (`#3d6a0a`) for contrast, so it reads darker than dark mode. Risk: lime plus mint are both green. They differ in hue (125 vs 175) and every status carries a word and a dot.

**Type.** Geist (400/500/600) + Geist Mono (400/500/600). Reason: sans and mono are one family with matching x-height, so mono ids sit in sentences without baseline jumps; Orca uses Geist, so the look matches the reference. License SIL OFL 1.1 (`fonts/GEIST-OFL.txt`), woff2 Latin subsets from `@fontsource` (about 10-13KB each, 6 files = 69KB). Bundled with `@font-face` urls to same-origin files, so `font-src 'self' data:` holds, no CDN. Scale 11/12/13/14/16/22/26, tight 1.2 headings.

**Scale.** Space 4/8/12/16/24/32/48. Radius 3/4/6/8/10/pill (6px controls, 8px cards, 10px composer). Shadow: floating layers only. Rail 232px, collapses to 56px, or to a drawer under 760px.

**Motion.** 110ms/160ms with one easing `cubic-bezier(.3,.7,.4,1)`; one orchestrated moment: running edge as moving dots (0.8s); live dots pulse; node status change flashes the node ring once (2.4s). Off under reduced motion.

**Wireframes**
```
RUNS/GRAPH desktop 1280
+------------+--------------------------------------------+-------------+
| orch       | Migrate auth to OIDC     [Stop][Retry] Live |             |
| [search /] | run..3418 started elapsed nodes 1/4 (1 run) |  Inspector  |
| RUNS    4  | ....stage1....stage2.........stage3........ | Write tests |
| o Migrate  | ...[Plan done]--[Implement running]--.....  | (Error)     |
| o Nightly  | ...............  [Review waiting]........   | profile ... |
| o Fix flaky| ...............--[Write tests ERROR].....   | log tail    |
| CHATS   3  | ..dotted canvas.............................| [Retry node]|
| o Summ..   |                                            |             |
| Profiles   |                                            |             |
| Schedules  |                                            |             |
| meters     |                                            |             |
+------------+--------------------------------------------+-------------+
RUNS mobile 375                           CHAT desktop (picker open)
| [=] Migrate auth..  Live [o] |         | rail | Title                       |
| [Stop run][Retry failed]     |         |      | user: soft box              |
| facts + (1 running)(1 error) |         |      | | Read state.json    0.2s   |
| .  [Plan        Done]        |         |      | | Run bun test   3 failed   |
| .  [Implement   Running]     |         |      | prose, worker card          |
| .  [Write tests Error]       |         |      |        +------------------+ |
| .  [Review      Waiting]     |         |      |        | search models    | |
| Inspector: Write tests ...   |         |      |        | Pinned / Local   | |
                                          |      | [att] Message...           |
CHAT mobile: top bar + same messages;     |      | [+][Claude][prof][model](^)|
composer docked, picks row scrolls.
```
Screens: `proto/B-runs.html`, `B-chats.html`, `B-profiles.html` (+ states). Shots: `shots/B-*`.

---
## Side by side
| | A | B |
|---|---|---|
| Shell | top bar + mobile tab bar | left rail, drawer on mobile |
| Accent | blue (running, selected) | lime (live, primary); focus is blue |
| Fonts | Plex (bundled, add 500) | Geist + Geist Mono (+69KB) |
| Run page | strip + graph + detail row | facts + canvas + inspector |
| Chat | thread list pane + conversation | rail tree + conversation, popover picker |
| Effort | tokens + shell + 4 page tweaks | tokens + new shell + all pages |
