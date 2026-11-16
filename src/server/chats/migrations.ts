/** Numbered, append-only. A migration that shipped is never edited: add the next number. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id),
    title TEXT NOT NULL,
    harness TEXT NOT NULL,
    profile TEXT NOT NULL,
    model_id TEXT,
    session_id TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE INDEX chats_updated ON chats(updated_at DESC, id DESC);
  CREATE INDEX chats_project ON chats(project_id, updated_at DESC);
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    role TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('pending','streaming','done','error','stopped')),
    error TEXT,
    model_used TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL,
    started_at TEXT,
    finished_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_chat ON messages(chat_id, id);
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    message_id TEXT REFERENCES messages(id),
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    rel_path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX attachments_chat ON attachments(chat_id);
  CREATE INDEX attachments_message ON attachments(message_id);
  CREATE VIRTUAL TABLE messages_fts USING fts5(
    content, chat_id UNINDEXED, message_id UNINDEXED, tokenize = 'unicode61 remove_diacritics 2'
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN context_truncated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE messages ADD COLUMN warning TEXT;
  `,
  `
  ALTER TABLE chats ADD COLUMN title_manual INTEGER NOT NULL DEFAULT 0;
  `,
  `
  ALTER TABLE chats ADD COLUMN cwd TEXT;
  CREATE TABLE folder_use (
    path TEXT PRIMARY KEY,
    last_used_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN parts TEXT;
  `,
  `
  ALTER TABLE chats ADD COLUMN effort TEXT;
  `,
  `
  CREATE TABLE chat_queue (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id),
    text TEXT NOT NULL DEFAULT '',
    attachments TEXT NOT NULL DEFAULT '[]',
    position INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued','running','sent','cancelled')),
    created_at TEXT NOT NULL,
    edited_at TEXT,
    message_id TEXT
  );
  CREATE INDEX chat_queue_chat ON chat_queue(chat_id, state, position);
  CREATE TABLE chat_queue_state (
    chat_id TEXT PRIMARY KEY REFERENCES chats(id),
    paused INTEGER NOT NULL DEFAULT 0,
    reason TEXT
  );
  `,
];
