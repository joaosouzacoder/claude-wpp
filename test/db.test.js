import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../src/db.js'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'db-')), 'sub', 'wpp.db')

test('cria o arquivo e o diretório que faltava', () => {
  const db = openDb(fresh())
  const tabelas = db.prepare("select name from sqlite_master where type='table'").all().map((r) => r.name)
  assert.ok(tabelas.includes('chats'))
  assert.ok(tabelas.includes('messages'))
  assert.ok(tabelas.includes('outbox'))
  db.close()
})

test('liga o WAL, porque o claude lê enquanto o daemon escreve', () => {
  const db = openDb(fresh())
  assert.equal(db.prepare('pragma journal_mode').get().journal_mode, 'wal')
  db.close()
})

test('busca textual funciona pelo índice fts', () => {
  const db = openDb(fresh())
  db.prepare("insert into chats (jid, name, kind, updated_at) values ('1@g.us', 'Líderes', 'group', 0)").run()
  db.prepare(`insert into messages (wa_id, chat_jid, from_me, ts, kind, body)
              values ('A', '1@g.us', 0, 10, 'text', 'o deploy da hml quebrou de novo')`).run()

  const achou = db.prepare(`select m.body from messages m
                            join messages_fts f on f.rowid = m.id
                            where messages_fts match 'deploy'`).all()
  assert.equal(achou.length, 1)
  db.close()
})

test('abrir de novo não destrói o que já estava lá', () => {
  const caminho = fresh()
  const primeira = openDb(caminho)
  primeira.prepare("insert into chats (jid, name, kind, updated_at) values ('1@g.us', 'Líderes', 'group', 0)").run()
  primeira.close()

  const segunda = openDb(caminho)
  assert.equal(segunda.prepare('select count(*) c from chats').get().c, 1)
  segunda.close()
})

test('a mesma mensagem não entra duas vezes', () => {
  const db = openDb(fresh())
  db.prepare("insert into chats (jid, name, kind, updated_at) values ('1@g.us', 'Líderes', 'group', 0)").run()
  const inserir = db.prepare(`insert or ignore into messages (wa_id, chat_jid, from_me, ts, kind, body)
                              values ('A', '1@g.us', 0, 10, 'text', 'oi')`)
  inserir.run()
  inserir.run()
  assert.equal(db.prepare('select count(*) c from messages').get().c, 1)
  db.close()
})
