import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/db.js'
import { createCapture } from '../src/capture.js'

// The row and the file have different lifetimes: the message is kept, the file
// is pruned at 30 days. So the path is recorded, and its absence is meaningful.
const mensagem = (message, extra = {}) => ({
  key: { remoteJid: '5511999999999@s.whatsapp.net', id: `ID-${Math.random()}`, ...extra },
  message,
  messageTimestamp: 1700000000,
  pushName: 'Fulano',
})

function novo() {
  const db = openDb(':memory:')
  return { db, capture: createCapture({ db }) }
}

const linha = (db) => db.prepare('select kind, body, media_path from messages order by id desc limit 1').get()

test('o caminho do arquivo é guardado junto da mensagem', () => {
  const { db, capture } = novo()
  capture.record(mensagem({ videoMessage: { seconds: 14, caption: 'olha' } }), { mediaPath: '/tmp/media-me/1-a.mp4' })

  const r = linha(db)
  assert.equal(r.kind, 'video')
  assert.equal(r.media_path, '/tmp/media-me/1-a.mp4')
  // O corpo legível não muda: é o que a busca e a leitura da conversa usam.
  assert.equal(r.body, '[vídeo 0:14] olha')
})

test('mensagem sem arquivo guardado fica com caminho nulo', () => {
  const { db, capture } = novo()
  capture.record(mensagem({ documentMessage: { fileName: 'enorme.zip' } }))

  const r = linha(db)
  assert.equal(r.media_path, null)
  assert.equal(r.body, '[documento: enorme.zip]')
})

test('texto continua sem caminho, como sempre', () => {
  const { db, capture } = novo()
  capture.record(mensagem({ conversation: 'oi' }))

  assert.equal(linha(db).media_path, null)
})

test('a coluna media_path existe num banco criado agora', () => {
  const { db } = novo()
  const colunas = db.prepare('pragma table_info(messages)').all().map((c) => c.name)
  assert.ok(colunas.includes('media_path'), colunas.join(', '))
})

test('um banco no schema anterior ganha a coluna sem perder mensagem', () => {
  // A garantia que importa: o banco que já está no disco do João não tem a
  // coluna. Aqui ele é criado no schema antigo, fechado, e reaberto por openDb.
  const caminho = join(mkdtempSync(join(tmpdir(), 'db-antigo-')), 'wpp.db')
  const antes = new DatabaseSync(caminho)
  antes.exec(`
    CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT, kind TEXT, updated_at INTEGER);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY, wa_id TEXT NOT NULL, chat_jid TEXT NOT NULL REFERENCES chats(jid),
      sender_jid TEXT, sender_name TEXT, from_me INTEGER NOT NULL, ts INTEGER NOT NULL,
      kind TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', quoted_wa_id TEXT,
      UNIQUE(chat_jid, wa_id)
    )`)
  antes.prepare('insert into chats (jid, kind, updated_at) values (?,?,?)').run('5511999999999@s.whatsapp.net', 'dm', 1)
  antes.prepare('insert into messages (wa_id, chat_jid, from_me, ts, kind, body) values (?,?,?,?,?,?)')
    .run('X1', '5511999999999@s.whatsapp.net', 0, 1, 'text', 'mensagem antiga')
  antes.close()

  const db = openDb(caminho)
  const colunas = db.prepare('pragma table_info(messages)').all().map((c) => c.name)
  assert.ok(colunas.includes('media_path'), colunas.join(', '))

  const velha = db.prepare("select body, media_path from messages where wa_id = 'X1'").get()
  assert.equal(velha.body, 'mensagem antiga')
  assert.equal(velha.media_path, null, 'linha antiga segue significando o que significava')

  // E o banco migrado continua aceitando gravação nova, com caminho.
  const capture = createCapture({ db })
  capture.record(mensagem({ imageMessage: { caption: 'nova' } }), { mediaPath: '/tmp/media-me/x.jpg' })
  assert.equal(linha(db).media_path, '/tmp/media-me/x.jpg')
})
