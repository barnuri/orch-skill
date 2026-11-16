# Chat memory per harness

Dashboard chats run one process per message on every harness except claude (one live process).
Each chat stores the harness-side session id in `chats.session_id`. Code: `src/server/chats/sessions/turn-session.ts`.
`/api/chat-options` reports `persistent` (one live process) and `memory` (`process`, `session`, `replay`).

| Harness | Continue flag (from `--help`) | How the id is learned | `memory` | Fallback |
|---|---|---|---|---|
| claude | stream-json process, `--resume <id>` after idle | `system` event of the live process | process | none needed |
| copilot | `--session-id <id>` creates or resumes | the dashboard mints a UUID on turn 1 | session | lost id: fresh UUID + replay |
| pi | `--session-id <id>` creates or resumes, `--session-dir <dir>` | the dashboard mints a UUID; sessions live in `<home>/chats/pi-sessions` (`ORCH_PI_SESSION_DIR`, see `adapter_pi`) | session | a missing id is created, so it cannot be lost |
| cursor-agent | `--resume [chatId]`, `create-chat` | `cursor-agent create-chat` runs before turn 1 and prints the id | session | create-chat fails or id rejected: replay + warning |
| opencode | `--session <id>` (id must exist), `--continue`, `--title` | turn 1 gets `--title orch-chat-<chatId>` (`ORCH_SESSION_TITLE`); the id is read from `opencode session list --format json` by title | session | list unreadable or id rejected: replay + warning |
| local-llm | none (stateless `/chat/completions`) | none | replay | history is sent in the prompt every turn |

## Replay

Used by local-llm every turn, and by any turn that has no usable session id.
The prompt gets the newest finished user/assistant messages that fit 24,000 characters (about 6k tokens, `REPLAY_CHAR_BUDGET` in `sessions/history-replay.ts`), oldest dropped first.
A single message larger than the room left is cut from its start. When anything is dropped the reply row gets `context_truncated = 1`.

## Lost session

A resumed turn that exits non-zero with no output and an error that mentions a session or chat (`not found`, `invalid`, ...) is retried once with a fresh session and the history replayed.
The reply row gets a `warning` (shown by the dashboard, also in the SSE `done` event). `chats.session_id` is replaced by the new id.

## Unverified assumption

`opencode session list --format json` is assumed to print an array of `{ "id", "title" }` (or `{ "sessions": [...] }`). Not run against a real model; the fake in `src/server/chats/testing/fake-harness.ts` follows the same shape.

## Chat folders (working directory)

A chat can be attached to a folder; the agent process of every turn then starts with that folder as its cwd.

- **Data.** `chats.cwd` (absolute real path, null when unset) and the existing `projects.path` (the project's default folder). The effective folder is the chat's own, else its project's, else a scratch folder (`<home>/chats/workspace`). `folder_use` remembers the last pick of each folder. Migration 4 adds both; history is never touched.
- **Subfolder.** `chats.subfolder` (nullable, migration 15) is a relative path inside the project folder. **Effective folder: `chat.cwd` when the chat has its own folder (it wins), else `<project.path>/<subfolder>` when a subfolder is set, else `project.path`, else the scratch folder.** Chats without a subfolder are unchanged. Every harness turn (claude, opencode, pi, local-llm), the workspace (`<cwd>/.orch/chats/<id>/`) and the browser profile folder use that effective folder; a change between turns replaces an idle session like a folder move. Rules (`src/shared/subfolder.ts`, `src/server/chats/subfolder.ts`): trimmed, duplicate slashes collapsed, trailing slash dropped; refused: absolute path, leading `~`, `.` or `..` segment, backslash, NUL, a name over 200 characters, more than 6 levels, a symlink that leaves the project folder (every existing level is resolved before anything is created), and a chat whose project has no folder (400 `subfolder needs a project with a folder`). The folder is created with mkdir -p when it is set and again before every turn; if that fails the turn runs in the project folder and the chat shows an amber warning. A new project path keeps the subfolder. API: `subfolder` on `POST /api/chats`, `PATCH /api/chats/{id}` `{subfolder}` (`null` or `""` clears), and on every chat read and list; `GET /api/chats/folders?depth=2` adds grandchildren named `parent/child`. UI: a Subfolder field (suggestions, resulting path, Save on blur or Enter, Clear) in the chat settings and on the start page, only for a project with a folder; the folder chip reads `project / subfolder`.
- **Roots.** `settings.chat_roots` in `profiles.json` (absolute paths, `~` allowed); default `["~/sandbox/private"]`. A folder is accepted only when it is absolute, has no `..` segment, exists, is a directory and its `realpath` (symlinks resolved) is inside a root. Otherwise the API answers 400 `folder: …`. The check runs again at every turn, so a folder swapped for a symlink that leaves the roots falls back to the scratch folder (the chat shows a warning).
- **API.** `GET /api/chats/folders?root=` (child folders of a root, recent first then by name, no dot folders or `node_modules`, at most 200), `PATCH /api/chats/{id}/folder` and `PATCH /api/projects/{id}/folder` with `{"path": "<dir>" | null}`, `cwd` on `POST /api/chats`. Chat reads and lists carry `cwd` and `effective_cwd`.
- **Turns.** claude, pi and the dispatch-based chats start their process with the effective folder as cwd; opencode also gets `--dir`. A running turn keeps its folder; the session manager replaces an idle session whose folder changed, so a move applies from the next message.
- **UI.** Folder chip in the chat header and chat list (a project-inherited folder is marked), a searchable picker with a free path field (server-validated; a bottom sheet on phones), and a project folder setting on the project page.

## Chat-only page (`/chat`)

The dashboard server also serves the Chats page alone, with no rail or other pages, for phones and a desktop app window.

- `/chat` opens the thread list; `/chat/<chat-id>` opens one thread; `/chat?project=<id>` opens a project; `/chat?folder=<path>` starts a new chat in that folder.
- Same auth as the dashboard: a loopback peer needs no token; anyone else opens `/chat?token=<t>` once (kept in `sessionStorage`, scrubbed from the address bar). The page HTML is public, `/api/*` stays guarded. The Chat tab's "Open chat-only" button opens a new tab with the token; "Copy link" copies it without.
- It is the same `ChatsPage` as the Chat tab, mounted by a thin `ChatShell` (`src/web/chats/ChatShell.tsx`); the dashboard mounts it in `AppShell`. A shell tells the page about itself through `ChatFrameContext`. The page takes its height from `--hdr` and `--tabbar-h`, which `AppShell` measures and `body.chat-only` sets to 0. Every chat feature therefore shows in both. `chat-shells.test.tsx` renders both shells and compares the controls.
- The sidebar is persistent from 900 px, a drawer (hamburger) below. A small dot shows when the server is offline.
- Installable: `<link rel="manifest">` plus `apple-mobile-web-app-capable` meta tags. The manifest is `src/web/chat.webmanifest` (name Orch chat, `display: standalone`, `start_url: /chat`, tokens' dark colours, icons `/chat/icon.svg` and `/chat/icon-dark.svg` from `src/snapshot/favicon*.svg`), also served at `/chat/manifest.webmanifest`. No service worker. Add to Home Screen opens it fullscreen; a remote device must sign in with the token once, since `sessionStorage` is not shared with the installed app.

## Chat message parts (tool cards, todos, reasoning, diffs)

A message row carries `parts` (JSON column, migration 5; `null` on old rows, which render their `content` as before). Types live in `src/shared/chat-parts.ts`: `text`, `reasoning`, `tool-call` (id, name, summary, input, state `running|done|error`, output, started_at, ended_at), `todo` (items: pending, in_progress, done), `file`, `diff` (path, before, after). Tool calls and reasoning are their own `tool` rows; a tool result updates the row and re-sends it as a `message` event.

| Harness | Stream | Parts produced |
|---|---|---|
| claude | stream-json: `tool_use` (+ `tool_result` in `user` lines), `thinking_delta` | tool-call with result, todo (`TodoWrite`), diff (`Edit`, `Write`), reasoning |
| opencode | JSON lines: `tool_use` with `state` (completed or error, input, output), `reasoning` | same; `todowrite`, `edit`, `write` |
| pi, copilot, cursor-agent, local-llm | plain text | none: text only (no structured stream) |

Libraries (installed at the repo root, one adapter file each in `src/web/chats` so they can be swapped):

- `streamdown` (Vercel, streaming markdown): `Markdown.tsx`. Memoizes finished blocks and repairs unclosed markdown, so a streaming reply does not flicker; sets text direction per block. Used with `controls={false}` and our own `code`, `table` and `input` components, so the look comes from our tokens, not its Tailwind classes. Task lists render as checkboxes (`.task-box`, custom styled).
- `diff` (jsdiff, `diffLines`): `DiffView.tsx`, lazy-loaded, about 30 KB. Chosen over `react-diff-viewer-continued` (emotion runtime, large) and `diff2html` (needs patch text and its own CSS).
- Kept `highlight.js` (already bundled, lazy) instead of adding `shiki`: shiki grammars would add several hundred KB for no new feature.
- Not used: `@assistant-ui/react` and Vercel `ai-elements` (they assume Tailwind or shadcn and their own state model; our thread is virtualized and SSE-driven). `ToolCard`, `Reasoning`, `Todos` are small and use our tokens.

Bundle (`bun build src/web/index.html --splitting --target=browser`): entry chunk 1,882,856 to 1,883,502 bytes; the lazy Markdown chunk grew from 436 KB to about 1,008 KB (streamdown plus `diff`). First load is unchanged.

## Workspace per chat and per folder

Every chat has a workspace that stores artifacts, knowledge and memory, so the chat gets better over time. One `Workspace` class (`src/server/chats/workspace.ts`) serves two scopes; only the root differs.

| Scope | Root (chat has a folder) | Root (no folder) |
|---|---|---|
| `chat` | `<cwd>/.orch/chats/<chat-id>/` | `<orch home>/chats/data/<chat-id>/` |
| `folder` | `<cwd>/.orch/shared/` (all chats of the folder) | none: the folder scope answers 400 |

Layout of a root: `MEMORY.md`, `knowledge/`, `artifacts/`, and for the chat scope `chat.json` (id, title, created, harness, `moved_from`). It is created lazily by the first write or the first agent turn. `<cwd>/.orch/.gitignore` holds `*`, so the repository stays clean. `<cwd>/.orch/chats/index.json` lists the chats of the folder (id, title, updated); it is kept when a chat is created, renamed or moved (only when the index already exists, or when a workspace is created).

- **Agent.** `ChatService.workspaceInstructions` appends a block under 1,000 characters to the prompt of the first turn (per server run) and again when a `MEMORY.md` changed. It is not stored in the visible message. local-llm gets it every turn (no session). The block names both roots (shared first), the rule "write to the chat scope; write to the shared scope only for facts every chat of the folder should know, one short dated line each; never edit another chat's directory", and the project description as project instructions (cut to fit).
- **API** (`workspace.controller.ts`, DTOs in `src/shared/dto/workspace.ts`): `GET /api/chats/{id}/workspace`, `GET|PUT .../workspace/memory`, `GET .../workspace/files/{area}/{name}` (images and text inline, the rest downloads), `POST .../workspace/files/{area}` (multipart or `X-Filename`), `DELETE .../workspace/files/{area}/{name}` (moves to `.trash/`), `GET .../workspace/export` (zip). All take `?scope=chat|folder`. Limits: upload 20 MB, memory 200 KB. Names are bare (no separator, no leading dot); every file is checked to be a regular file inside the area after `realpath`; symbolic links are never read, written or served; an `.orch` link that leaves the folder is refused.
- **Move.** A chat that moves to another folder keeps its old workspace where it was; the new `chat.json` records `moved_from` and the panel shows a note. Nothing is copied.
- **UI.** A Workspace button in the chat header (also on phones) opens a side sheet (full screen on phones): scope switch (This chat, This folder), tabs Memory (editable, Save), Knowledge (upload) and Artifacts, preview, download, delete to trash, copy folder path and Download workspace (zip).

## Chat settings fold and effort

The harness, profile, model and effort row above the composer is folded into one summary line (`ChatSettings.tsx`, preference `orch.chat.prefs` in `localStorage`, closed by default, global). A badge on the summary shows a picker problem or a failed last reply (red) and a chat warning or an unset harness (amber).

Effort is stored per chat (`chats.effort`, migration adds a nullable column; null is Auto and passes nothing). Mapping, checked with `--help`:

| Harness | Levels | Argument |
|---|---|---|
| claude | low, medium, high, max | `--effort <level>` (the CLI also has `xhigh`) |
| opencode | low, medium, high, max | `-m provider/model#<level>` (variant names depend on the provider; not checked per model) |
| copilot | none offered | the CLI has `--reasoning-effort`, but chat turns go through dispatch.ts, which has no pass-through |
| cursor-agent, pi, local-llm | none | no flag |

`/api/chat-options` lists `efforts` per harness. A change applies from the next turn; switching to a harness without the level clears it. The hub reads a requested effort from the request body (`reasoning_effort`), which opencode and claude set from these arguments, so the hub needed no change. Not done: showing `selected_effort` from `/api/smart-auto/history` in the message footer (the history is keyed by a salted worker hash the dashboard cannot derive).

## Browser profiles (persistent Playwright logins)

Code: `src/server/chats/browser-profile.ts`. Every chat gets a persistent Chromium user-data dir so agents stop asking for logins.

- **Location.** `<folder>/.orch/browser/default/` (gitignored by `.orch/.gitignore` containing `*`, created when missing, mode 0700). A chat whose folder is the project's folder, or whose project has no folder, uses that one. A chat whose folder differs from its project's uses `<chat folder>/.orch/browser/default/` and is offered the project's as the second profile `project`. A chat without a folder uses `<home>/browser/chat-default/`. Chats in one folder share the profile.
- **Seeding.** `settings.browser_profile_seed: true` in `profiles.json` (default off) copies only `Default/Cookies*`, `Default/Network/Cookies*` and `Default/Local Storage` from the project profile into an empty primary one, and only when the project profile is not in use. Never automatic otherwise.
- **How agents get it (verified against `@playwright/mcp` and `playwright-cli` installed here).** Playwright MCP reads `PLAYWRIGHT_MCP_USER_DATA_DIR` (same as `--user-data-dir`). claude chats: the session factory adds it to the claude process env, so the MCP server claude starts uses the folder's primary profile. `PLAYWRIGHT_BROWSERS_PATH` is passed on only when already set. `playwright-cli` has no env variable: `open --persistent --profile <path>`; the instruction note says so. opencode chats: the MCP server is started by the long-lived `opencode serve` of the profile, so its env cannot change per chat; the note carries the path and the agent passes it (`--user-data-dir` in the MCP entry of `opencode.jsonc`, or `playwright-cli`). Not injected per chat for pi, copilot, cursor-agent, local-llm: the note only.
- **Lock.** `<profile>/.orch-lock` holds `{pid, chat}` for the length of one turn (the pid is the dashboard server's). A live lock of another chat gives this chat a clone `<name>-clone-<chat id>` (caches and `Singleton*` left out); the note says logins made in it are not kept. A clone is moved to `.trash` when the turn ends and by `sweepClones` after 24 h. A dead pid's lock is taken over. A claude session's env is fixed at spawn, so for claude a clone only changes the path in the note.
- **Note.** `browserNote()` (under 400 characters; the second profile and the `playwright-cli` hint are dropped first when paths are long) is appended after the workspace block on a session's first turn and when the path changes; local-llm gets it every turn.
- **API.** `GET /api/browser-profiles` (path, size, last used, chats, in use; metadata only) and `POST /api/browser-profiles/forget {path}` (moves the folder to a `.trash` folder next to it; 404 unknown, 400 outside `<folder>/.orch/browser/` of a chat root or `<home>/browser/`, 409 in use). Known profiles are in `<home>/browser/registry.json`.
- **Safety.** Cookie files are never read or logged by the server. The workspace zip skips `.orch/browser`, the artifact scan skips `.orch`.

## Agent questions (`question` and `AskUserQuestion`)

The agent's question tool becomes a `question` message part (`src/shared/chat-question.ts`): `id` (harness tool call id), `state` (`pending`, `answered`, `dismissed`), `questions[]` (`header`, `question`, `options[{label, description}]`, `multiple`, `allowCustom`), `answers` (one label list per question) and timestamps. It lives in its own `tool` row, so it survives a reload and a dashboard restart.

- **Detection.** Both parsers already emit a `tool` event; `ChatService.consume` maps `question`/`AskUserQuestion` (opencode: `{questions:[{question, header, options, multiple?, custom?}]}`, claude: `{questions:[{question, header, options, multiSelect}]}`) with `questionPartFromTool`.
- **No live channel (verified).** opencode 2.3.0 `run` cancels the tool at once (`state.status: "error"`, "This non-interactive run cannot ask the user questions"), and its `opencode serve` API has no `/question/{id}/reply`: only the v2 `/api/session/{id}/form/{formID}/reply`, which the `run` question tool does not create. `claude -p` reads stdin from a file the turn wrapper owns, so a `tool_result` cannot be written to a running turn, and its AskUserQuestion also errors at once. So the turn ends instead of continuing on assumptions: the process is stopped (`endProcess`), the reply is closed as `done`, the session id is stored (claude `initSeen`, opencode session id on abort) and the next turn resumes it.
- **Answer.** `POST /api/chats/{id}/questions/{qid}/answer` with `{answers: string[][]}` (or `custom` for a single question) or `{dismiss: true}`. Typed text is accepted only when `allowCustom`. The part is settled first, then the answer is sent as the next user message `[Answer to your question]\n- <header>: <question> → <answers>` (a skip says the question was skipped). 404 unknown question, 409 already settled or a reply running, 400 invalid; a failed send puts the part back to `pending`. A normal message sent while a question waits dismisses it. `GET /api/chats/questions/waiting` lists the chats that wait.
- **UI.** `QuestionCard.tsx`: pinned above the composer while pending (radio or checkbox options, Other field, steps for several questions, keys 1-9, Enter, arrows; Send answer / Skip), one quiet line in the thread, a collapsed read-only card once settled. Amber dot in the chat list and `(n)` in the tab title. A question over 24 h old says the agent stopped waiting; Skip is always available.
- **Not done.** No live answer delivery: a harness that offers one (opencode forms) would need the question tool to create a form first.

## Message queue (send while a reply runs)

A message sent while a turn runs (or while earlier ones wait) goes into the chat's queue instead of failing. Code: `src/server/chats/queue.ts` (`ChatQueue`), hooks in `service.ts` (`submit`, `turnEnded` call at the end of `consume`, `queue` SSE event), DTOs in `src/shared/dto/chat-queue.ts`, controller `chat-queue.controller.ts`, UI `src/web/chats/MessageQueue.tsx` + `queue.css`.

- **Data.** Migration 7: `chat_queue` (id, chat_id, text, attachments JSON, position, state `queued|running|sent|cancelled`, created_at, edited_at, message_id) and `chat_queue_state` (paused, reason). Rows are never deleted: sent and cancelled stay.
- **Loop.** One running turn per chat. When a reply ends `done`, the next queued message starts. A failed or stopped reply, a failed start, or a dashboard restart pauses the queue with a reason; `POST /queue/resume` (Resume button) continues. At boot a chat with queued items and no adopted turn shows them paused; a `running` item without a turn is marked `sent`.
- **API.** `POST /api/chats/{id}/messages` answers 202 `{queued:true, queue_id}` (ids null) when queued. `GET /queue`, `POST /queue` (same body as send), `PATCH /queue/{qid}` (only while queued), `DELETE /queue/{qid}` (cancel), `POST /queue/{qid}/send-now`, `POST /queue/reorder {ids}`, `POST /queue/resume`, `POST /stop` (also pauses a non-empty queue). Every change is pushed as a `queue` event (full snapshot) and replayed on connect.
- **Limits.** 20 queued per chat (409), text 50 KB (413), empty 400. Edit, delete, reorder and send-now of a message that already started answer 409 `Already started`; the UI shows that text.
- **Send now.** Stops the running turn with the session's normal `stop()` (partial reply kept, ends `stopped`), then runs the chosen message next and clears the pause. The UI asks first. Not done: harness-specific graceful interrupts (opencode abort API, claude SIGINT); `stop()` as before is used.
- **UI.** The composer never disables while running (button reads Queue, Stop stays beside it). Tray above the composer: running row with Stop, queued rows with drag handle, up/down, Edit (Esc cancels, Ctrl/Cmd+Enter saves), Send now, Delete; paused notice with Resume. Pending `Queued` bubbles at the end of the thread, header counter `N queued`. Same page in both shells.
- **Known gap.** Attachments of a queued message are still "unattached" and the startup 24 h upload sweep can remove them.

## Artifacts panel

An artifact is a file in the chat's `artifacts/` folder (the workspace area), or a file the agent wrote with a Write or Edit tool call elsewhere under the chat folder when its extension is on the opt-in list (`<orch home>/chats/artifact-settings.json`, API `GET/PUT /api/artifact-settings`: `track_external`, `extensions`). Such files are copied into `artifacts/` after the tool call (and again at turn end); a symlink or a path that leaves the folder is refused.

- **Code.** `src/server/chats/artifacts.ts` (store, versions, scan, hub), `src/server/api/controllers/artifacts.controller.ts`, `src/shared/artifacts.ts` (kinds, reference text), `src/web/chats/artifacts/*` (hook, panel, renderers, css). `ChatView` wires the hook, `ArtifactLayout` (split view) and `ArtifactBar` (toggle, `@`, reference chips).
- **Versions.** Every distinct content is snapshotted as `artifacts/.versions/<name>/<n>` with `<n>.json` (time, turn id, author agent|user|restore). Restore writes the old content as a new version; nothing is removed. A user edit (`PUT .../artifacts/{name}`, optional `base_hash`, 409 on mismatch) records an author `user` version and the next prompt gets one line saying the user changed the file.
- **Live events.** `fs.watch` on `artifacts/` (debounce 150 ms) starts when a chat event stream is open and compares every file with its last snapshot. The chat SSE carries `event: artifact` with `{name, change: created|updated|deleted, version, kind, hash, turn}`. The panel opens by itself on the first created artifact of a turn (user setting, local storage `orch.artifacts.autoopen`).
- **API.** `GET /api/chats/{id}/artifacts`, `.../{name}/versions`, `.../{name}/content?version=&download=1&preview=1` (preview refuses more than 5 MB with 413), `PUT .../{name}`, `POST .../{name}/restore`, `POST .../{name}/view`. Names go through `cleanName`, the file through the workspace's `resolveFile` (regular file, real path inside the folder).
- **HTML isolation.** The page CSP (`script-src 'self'`) would block the scripts of a `srcdoc` iframe, which inherits it. So `POST .../view` returns `/artifact-view/<capability>` (random, 30 minutes, one artifact). That route needs no token and sets `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; img-src data: blob:` (no network). The iframe also has `sandbox="allow-scripts"` (no same-origin), so no cookie, token or storage of the app is reachable, even when the address is opened in a new tab. SVG opens in a new tab through the same route with a script-less sandbox CSP. Both page CSPs gained `frame-src 'self' blob:`.
- **Renderers** (lazy chunks): html, markdown (streamdown), code (highlight.js, line numbers, changed lines marked for 2.5 s after a live update), svg and images (blob `<img>`), mermaid (lazy `mermaid`, shown as an SVG image), csv table, json tree, pdf (blob iframe), text. React/TSX shows as code with a note: no bundler runs in the browser. Unknown types download only. Diff uses `diff`.
- **Talking about it.** `Ask about this`, the `@` menu, a typed `@name`, and the floating `Comment` button on a selection add a reference. The sent text gets `Artifact reference: - <dir>/<name> (v<n>, hash <h>, lines a-b)` plus the quote, and the instruction to edit the file in place and re-read it when the hash differs. The reference is visible in the user's message.
- **Not done:** the iframe reloads on a live update (its scroll is lost); CodeMirror is not installed, so Edit is a plain textarea.

## Voice: dictation and conversation mode

One implementation in `src/web/chats` and `src/web/lib`, mounted by `ChatView`, so both shells (dashboard and `/chat`) get it.

- **Speech to text.** `POST /api/voice/transcribe` forwards a clip to the hub `/v1/audio/transcriptions` (`src/server/chats/transcribe.ts`). Models: `whisper/whisper-large-v3`, then parakeet; a `he` language hint puts `ivrit/ivrit-large-v3-turbo` first. Limit 25 MB per clip; the hub wait grows with the clip (`upstreamTimeoutMs`: 2 min up to 10 min).
- **Recording never stops by itself.** Old cause of the cut-off: a hard 120 s timer (`MAX_CLIP_MS`) in both modes, a fixed 0.02 level threshold with a 1.2 s silence rule (a pause or quiet speech ended the clip; a noisy room never ended it), and one request per clip with a flat 120 s hub timeout. Now only the tap on Done (dictation) or the end-of-speech silence (conversation, `voice-vad.ts`) ends a recording.
- **VAD** (`EnergyVad`): noise floor from the quietest quarter of the first 0.5 s, start threshold `3x` floor, a lower stop threshold `1.6x` (hysteresis), end only after `endSilenceMs` of quiet that follows speech. Default 1.8 s, setting 0.8 to 4 s.
- **Chunking** (`ClipRecorder`, `SegmentPolicy`, ported from the voice-notes app, `/Users/barnu/sandbox/private/voice-notes/web/public/shared/speech-chunker.js` and `js/mic-recorder.js`): cut at a 700 ms pause after 5 s (a 250 ms word gap after 12 s), never mid-word; the next MediaRecorder starts before the old one stops (restart-free), so every piece is a complete file. With no pause for 60 s the cut is forced and the old recorder runs 0.8 s longer; `mergeOverlap` drops the repeated words. `ChunkTranscriber` transcribes 2 pieces at once, joins text in recording order and shows the finished prefix live (`partial`). A piece the hub refuses is decoded in the browser (`splitClip`), cut in two overlapping 16 kHz wavs and sent again; a short piece is tried once more.
- **Conversation mode.** Button next to the mic opens `ConversationView` (orb with Listening, Thinking, Speaking, Paused; live transcript; the reply as text with the spoken sentence highlighted; mute, pause, stop speaking, push to talk, settings sheet, End or Esc). `useVoiceConversation` sends through the normal `thread.send` (same queue), then speaks the reply sentence by sentence while it streams (`SpeechStream`, `TtsQueue`). States and barge-in are the pure reducer in `voice-machine.ts`. While it speaks, a second recorder with stricter thresholds watches for the user; if they talk it keeps recording, so the first words are not lost. The screen stays awake (Wake Lock, taken again when the tab returns). A pending question card is read with numbered options and a spoken number or label answers it (`matchSpokenOption`).
- **Text to speech.** The hub has no speech model (`/v1/models` lists only whisper, ivrit and parakeet for audio; `/v1/audio/speech` has no profile), so the browser `speechSynthesis` is the only engine; the voice is picked per sentence by language (Hebrew he-IL, else English), or the voice chosen in the sheet. Code is said as "code block", URLs and long paths skipped, tables skipped, lists summarised after 4 items, `₪`, `$`, `%` read as words. Settings are in `localStorage` key `orch.voice.settings.v1`.
- **Errors.** Mic denied, no secure context (the message links `/trust`), no voice for a language, hub failure: one sentence, the mode closes and the chat is back to text. Voice needs https or localhost.
- **Not done.** No hub TTS; speaking over a loudspeaker without echo cancellation can trigger a false barge-in; iOS Safari not tested on a device.

## Installable apps and push notifications

Two installable apps from one server: `Orch` (id `/`, scope `/`, start `/`) and `Orch chat` (id `/chat/`, scope `/chat/`, start `/chat/`; the start URL has the trailing slash because a start URL outside the scope fails the install check). Manifests are generated in `src/server/pwa/manifest.ts` and served at `/manifest.webmanifest` and `/chat/manifest.webmanifest`. Icons are PNGs in `src/web/pwa/static/icons/` (`bun scripts/gen-pwa-icons.ts` regenerates them from the SVG mark; the chat icon swaps background and mark colours). Bun's html bundler cannot keep an absolute route in `<link rel="manifest">`, so `src/web/pwa/head.ts` adds that link at load. The chat share target is `GET /chat/share` (text only) and fills the new-chat draft.

Service workers: `src/web/pwa/sw.ts` is bundled by the server into `/sw.js` (scope `/`) and `/chat/sw.js` (scope `/chat/`). Rules are in `sw-strategy.ts`: network-first for pages and manifests, cache-first for hashed assets, never `/api/`, `/artifact-view/`, `/ca.crt`, `/trust`, a `?token=` URL or a key. Caches are `orch-<app>-<hash of worker sources>`; old ones go on activate. A waiting worker shows `Update available` with Reload. `/offline.html` is the fallback with Retry.

Push (`src/server/push/`): `notify(category, payload)` on the hub (`pushHubFor(home)`) is the one entry. Categories: replies, questions, failures, runs, schedules. Chat events come from `ChatService.events` (`chat-hook.ts`: reply done, error, pending question, queue paused). Run events come from `run-watcher.ts`, which polls `runs/*/state.json`, tails `watchdog/actions.log` for flags and watches `schedules/*/claims`; it announces nothing from before the server started. A page of a chat that is visible and focused posts `/api/push/presence` every 2 s; the server sends nothing for that chat for 3 s after the last beat. A chat event goes to the devices of the chat app when one exists, else to the others (so one device does not show it twice). Body is at most 140 characters, secrets are redacted, tag `chat:<id>` makes replies replace each other.

API: `GET /api/push/key`, `POST /api/push/subscribe`, `DELETE /api/push/subscribe?endpoint=`, `GET /api/push/subscriptions`, `PATCH|DELETE /api/push/subscriptions/{id}`, `POST /api/push/test`, `POST /api/push/presence`. Push and install need https or localhost; on plain http the Settings section shows the secure link and `/trust`. Settings has the Notifications section; the chat app opens it from a quiet prompt (or `/chat/?notifications=1`).
