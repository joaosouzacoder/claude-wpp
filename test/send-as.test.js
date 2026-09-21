import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'
import { createWpp, formatDraft } from '../src/wpp.js'
import { createScheduler } from '../src/scheduler.js'

// Who a draft goes out as is decided when it is approved: /ok as the owner,
// /bot as the bot. Real db, outbox, wpp and scheduler; only the two WhatsApp
// accounts are fakes, each recording what it was asked to do.

function conta(rotulo) {
  const feitos = []
  return {
    feitos,
    sendText: async (jid, texto) => { feitos.push({ op: 'texto', jid, texto }); return `${rotulo}-TXT` },
    sendDocument: async (jid, doc) => { feitos.push({ op: 'doc', jid, ...doc }); return `${rotulo}-DOC` },
    deleteMessage: async (jid, waId) => { feitos.push({ op: 'apagar', jid, waId }) },
    state: () => 'open',
  }
}

function montar() {
  const db = openDb(':memory:')
  const outbox = createOutbox({ db, now: () => 1000 })
  const eu = conta('EU')
  const bot = conta('BOT')
  const avisos = []
  const wpp = createWpp({ db, outbox, wa: eu, bot, run: async () => ({ ok: true, text: 'ENVIAR: ok' }), config: { claudeBin: 'claude', agentCwd: '/tmp' } })
  const scheduler = createScheduler({ outbox, send: wpp.send, decide: wpp.decide, notify: (t) => avisos.push(t), now: () => 1000, log: {} })
  return { db, outbox, wpp, scheduler, eu, bot, avisos }
}

test('/ok manda pela conta do dono', async () => {
  const { outbox, scheduler, eu, bot, avisos } = montar()
  const d = outbox.create({ chatJid: '5511911111111@s.whatsapp.net', chatName: 'Fulano', body: 'oi' })
  outbox.approve(d.id, 'me')
  await scheduler.tick()
  assert.equal(eu.feitos.length, 1)
  assert.equal(bot.feitos.length, 0)
  assert.match(avisos.at(-1), /mandei como você para Fulano/)
})

test('/bot manda o mesmo rascunho pela conta do bot', async () => {
  const { outbox, scheduler, eu, bot, avisos } = montar()
  const d = outbox.create({ chatJid: '5511911111111@s.whatsapp.net', chatName: 'Fulano', body: 'oi' })
  outbox.approve(d.id, 'bot')
  await scheduler.tick()
  assert.equal(eu.feitos.length, 0)
  assert.deepEqual(bot.feitos, [{ op: 'texto', jid: '5511911111111@s.whatsapp.net', texto: 'oi' }])
  assert.equal(outbox.get(d.id).status, 'sent')
  assert.match(avisos.at(-1), /mandei pelo bot para Fulano/)
})

test('rascunho com anexo sai como documento, com o texto de legenda e os bytes do arquivo', async () => {
  const { outbox, scheduler, eu } = montar()
  const caminho = join(mkdtempSync(join(tmpdir(), 'anexo-')), 'handoff.md')
  writeFileSync(caminho, '# handoff\n')
  const d = outbox.create({
    chatJid: '5511911111111@s.whatsapp.net', chatName: 'Fulano', body: 'segue o handoff',
    attachment: { path: caminho, name: 'handoff.md', mimetype: 'text/markdown' },
  })
  outbox.approve(d.id, 'me')
  await scheduler.tick()
  const [envio] = eu.feitos
  assert.equal(envio.op, 'doc')
  assert.equal(envio.content.toString(), '# handoff\n')
  assert.equal(envio.fileName, 'handoff.md')
  assert.equal(envio.mimetype, 'text/markdown')
  assert.equal(envio.caption, 'segue o handoff')
})

test('anexo sem texto é um rascunho válido; sem texto e sem anexo não', () => {
  const { outbox } = montar()
  const d = outbox.create({ chatJid: 'x@s.whatsapp.net', body: '', attachment: { path: '/tmp/a', name: 'a.pdf', mimetype: 'application/pdf' } })
  assert.equal(d.attachment_name, 'a.pdf')
  assert.throws(() => outbox.create({ chatJid: 'x@s.whatsapp.net', body: '' }), /sem texto/)
})

test('/undo apaga pela conta que de fato mandou', async () => {
  const { outbox, scheduler, wpp, eu, bot } = montar()
  const d = outbox.create({ chatJid: '5511911111111@s.whatsapp.net', body: 'oi' })
  outbox.approve(d.id, 'bot')
  await scheduler.tick()
  const r = await wpp.undo()
  assert.equal(r.ok, true)
  assert.deepEqual(bot.feitos.at(-1), { op: 'apagar', jid: '5511911111111@s.whatsapp.net', waId: 'BOT-TXT' })
  assert.equal(eu.feitos.length, 0)
})

test('remetente fora de me/bot é recusado', () => {
  const { outbox } = montar()
  const d = outbox.create({ chatJid: 'x@s.whatsapp.net', body: 'oi' })
  assert.throws(() => outbox.approve(d.id, 'outro'), /remetente desconhecido/)
  assert.equal(outbox.get(d.id).status, 'pending')
})

test('o rascunho oferece as duas saídas e mostra o anexo', () => {
  const { outbox } = montar()
  const d = outbox.create({ chatJid: 'x@s.whatsapp.net', chatName: 'Fulano', body: '', attachment: { path: '/tmp/a', name: 'handoff.md', mimetype: 'text/markdown' } })
  const texto = formatDraft(d)
  assert.match(texto, /📎 handoff\.md/)
  assert.match(texto, new RegExp(`/ok ${d.id} manda como você · /bot ${d.id} manda pelo bot · /no ${d.id} descarta`))
})

test('banco antigo ganha as colunas novas, e o que já existia continua saindo como o dono', () => {
  const caminho = join(mkdtempSync(join(tmpdir(), 'migra-')), 'wpp.db')
  const antigo = new DatabaseSync(caminho)
  antigo.exec(`CREATE TABLE outbox (
     id INTEGER PRIMARY KEY, kind TEXT NOT NULL, chat_jid TEXT NOT NULL, chat_name TEXT,
     body TEXT NOT NULL, quoted_wa_id TEXT, check_prompt TEXT, scheduled_for INTEGER,
     status TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, decided_at INTEGER,
     sent_at INTEGER, sent_wa_id TEXT)`)
  antigo.exec("INSERT INTO outbox (kind, chat_jid, body, status, created_at) VALUES ('message', 'x@s.whatsapp.net', 'velho', 'approved', 1)")
  antigo.close()

  const db = openDb(caminho)
  const linha = db.prepare('SELECT * FROM outbox').get()
  assert.equal(linha.sender, 'me')
  assert.equal(linha.attachment_path, null)
  db.close()
  // Abrir de novo não tenta adicionar as colunas outra vez.
  openDb(caminho).close()
})
