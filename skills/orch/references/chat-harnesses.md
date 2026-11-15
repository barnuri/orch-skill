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

`opencode session list --format json` is assumed to print an array of `{ "id", "title" }` (or `{ "sessions": [...] }`). Not run against a real model; the fake in `src/server/chats/testing/fake-harness.sh` follows the same shape.
