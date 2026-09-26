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

  // Who the bot has written to. Only these get their replies passed on to the
  // owner: anyone else messaging the bot is ignored, as before.
  `CREATE TABLE IF NOT EXISTS bot_contacts (
     number       TEXT PRIMARY KEY,
     name         TEXT,
     last_sent_at INTEGER NOT NULL
   )`,

  // What the bot and that person have said to each other. Without it every
  // message the bot writes reads like a first contact — it greets, it
  // re-introduces itself — and it has no way to tell a question it must pass
  // on from small talk it can close by itself.
  `CREATE TABLE IF NOT EXISTS bot_messages (
     id      INTEGER PRIMARY KEY,
     number  TEXT NOT NULL,
     from_me INTEGER NOT NULL,
     body    TEXT NOT NULL,
     ts      INTEGER NOT NULL
   )`,

  'CREATE INDEX IF NOT EXISTS idx_bot_messages_number ON bot_messages(number, ts)',

  // Something he asked to happen again, or later: at its hour the assistant
  // is handed `prompt` in its own session and answers him in the chat.
  `CREATE TABLE IF NOT EXISTS tasks (
     id          INTEGER PRIMARY KEY,
     prompt      TEXT    NOT NULL,
     label       TEXT,
     daily_at    TEXT,
     tz          TEXT,
     next_run    INTEGER NOT NULL,
     status      TEXT    NOT NULL,
     created_at  INTEGER NOT NULL,
     last_run_at INTEGER
   )`,

  'CREATE INDEX IF NOT EXISTS idx_tasks_prox ON tasks(status, next_run)',

  // A reply the bot passed on to the owner, keyed by the id of the message he
  // sees — quoting that message is how he answers the right person.
  `CREATE TABLE IF NOT EXISTS relay (
     id              INTEGER PRIMARY KEY,
     owner_wa_id     TEXT UNIQUE,
     from_number     TEXT NOT NULL,
     from_name       TEXT,
     body            TEXT NOT NULL,
     received_at     INTEGER NOT NULL
   )`,
]

export function openDb(filePath) {
  if (filePath !== ':memory:') mkdirSync(dirname(filePath), { recursive: true })

  const db = new DatabaseSync(filePath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  for (const ddl of ESQUEMA) db.exec(ddl)
  migrar(db)

  return db
}

// Additive only: columns added to tables that already exist on disk. Every
// new column is nullable or defaulted so existing rows keep their meaning —
// a draft recorded before `sender` existed was always sent as the owner.
const COLUNAS_NOVAS = {
  // Where the received file was written, for the messages whose media is kept.
  // Null for every row recorded before this existed, which is what it means
  // now too: the message arrived, the file was not kept.
  messages: [
    ['media_path', 'TEXT'],
  ],
  outbox: [
    ['sender', "TEXT NOT NULL DEFAULT 'me'"],
    ['attachment_path', 'TEXT'],
    ['attachment_name', 'TEXT'],
    ['attachment_mimetype', 'TEXT'],
    // The formal wording /bot sends; `body` is the owner's own voice, for /ok.
    ['body_bot', 'TEXT'],
  ],
}

function migrar(db) {
  for (const [tabela, colunas] of Object.entries(COLUNAS_NOVAS)) {
    const existentes = new Set(db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name))
    for (const [nome, tipo] of colunas) {
      if (!existentes.has(nome)) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${nome} ${tipo}`)
    }
  }
}
