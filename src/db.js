import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// One statement per entry: SQLite runs one DDL at a time and this is also the
// migration list. Appending is how the schema evolves; never edit in place.
const ESQUEMA = [
  `CREATE TABLE IF NOT EXISTS chats (
     jid        TEXT PRIMARY KEY,
     name       TEXT,
     kind       TEXT    NOT NULL,
     updated_at INTEGER NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS messages (
     id           INTEGER PRIMARY KEY,
     wa_id        TEXT    NOT NULL,
     chat_jid     TEXT    NOT NULL REFERENCES chats(jid),
     sender_jid   TEXT,
     sender_name  TEXT,
     from_me      INTEGER NOT NULL,
     ts           INTEGER NOT NULL,
     kind         TEXT    NOT NULL,
     body         TEXT    NOT NULL DEFAULT '',
     quoted_wa_id TEXT,
     UNIQUE(chat_jid, wa_id)
   )`,

  'CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages(chat_jid, ts DESC)',
  'CREATE INDEX IF NOT EXISTS idx_msg_ts ON messages(ts DESC)',

  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
     USING fts5(body, content='messages', content_rowid='id')`,

  // The external-content index does not follow the table on its own.
  `CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
     INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
   END`,
  `CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
     INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
   END`,

  // A draft and a scheduled job are the same thing at different times:
  // scheduled_for NULL means "send as soon as it is approved".
  `CREATE TABLE IF NOT EXISTS outbox (
     id            INTEGER PRIMARY KEY,
     kind          TEXT    NOT NULL,
     chat_jid      TEXT    NOT NULL,
     chat_name     TEXT,
     body          TEXT    NOT NULL,
     quoted_wa_id  TEXT,
     check_prompt  TEXT,
     scheduled_for INTEGER,
     status        TEXT    NOT NULL,
     reason        TEXT,
     created_at    INTEGER NOT NULL,
     decided_at    INTEGER,
     sent_at       INTEGER,
     sent_wa_id    TEXT
   )`,

  'CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, scheduled_for)',
]

export function openDb(filePath) {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true })

  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  for (const ddl of ESQUEMA) db.exec(ddl)

  return db
}
