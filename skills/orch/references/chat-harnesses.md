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
- **Roots.** `settings.chat_roots` in `profiles.json` (absolute paths, `~` allowed); default `["~/sandbox/private"]`. A folder is accepted only when it is absolute, has no `..` segment, exists, is a directory and its `realpath` (symlinks resolved) is inside a root. Otherwise the API answers 400 `folder: …`. The check runs again at every turn, so a folder swapped for a symlink that leaves the roots falls back to the scratch folder (the chat shows a warning).
- **API.** `GET /api/chats/folders?root=` (child folders of a root, recent first then by name, no dot folders or `node_modules`, at most 200), `PATCH /api/chats/{id}/folder` and `PATCH /api/projects/{id}/folder` with `{"path": "<dir>" | null}`, `cwd` on `POST /api/chats`. Chat reads and lists carry `cwd` and `effective_cwd`.
- **Turns.** claude, pi and the dispatch-based chats start their process with the effective folder as cwd; opencode also gets `--dir`. A running turn keeps its folder; the session manager replaces an idle session whose folder changed, so a move applies from the next message.
- **UI.** Folder chip in the chat header and chat list (a project-inherited folder is marked), a searchable picker with a free path field (server-validated; a bottom sheet on phones), and a project folder setting on the project page.
