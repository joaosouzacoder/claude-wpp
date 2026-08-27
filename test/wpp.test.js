import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'
import { createWpp, parseVeredito, formatDraft, formatQueue } from '../src/wpp.js'

// --- leitura do veredito ---
// Fecha para o lado seguro: o que não for entendido vira erro, e o scheduler
// devolve a decisão para o João em vez de mandar às cegas.

test('ENVIAR é lido com o motivo', () => {
  assert.deepEqual(parseVeredito('ENVIAR: ele não respondeu nada sobre o macbook'), {
    send: true, reason: 'ele não respondeu nada sobre o macbook',
  })
})

test('PULAR é lido com o motivo', () => {
  assert.deepEqual(parseVeredito('PULAR: ele confirmou ontem que traz'), {
    send: false, reason: 'ele confirmou ontem que traz',
  })
})

test('tolera minúscula, acento e conversa em volta', () => {
  assert.equal(parseVeredito('Olhei a conversa.\npular: ele já disse que traz').send, false)
  assert.equal(parseVeredito('enviar - ninguém falou nada').send, true)
})

test('resposta que não decide nada vira erro, não vira envio', () => {
  assert.throws(() => parseVeredito('acho que talvez seja melhor você ver isso'), /não entendi/i)
  assert.throws(() => parseVeredito(''), /não entendi/i)
})

test('não inventa veredito quando as duas palavras aparecem: vale a primeira', () => {
  assert.equal(parseVeredito('PULAR: ele respondeu, não precisa ENVIAR de novo').send, false)
})

// --- textos mostrados ---

test('o rascunho mostra destino e texto exato antes de você aprovar', () => {
  const texto = formatDraft({ id: 3, kind: 'message', chat_name: 'Jane Doe', body: 'traz o macbook', scheduled_for: null })
  assert.match(texto, /#3/)
  assert.match(texto, /Jane Doe/)
  assert.match(texto, /traz o macbook/)
  assert.match(texto, /\/ok 3/)
  assert.match(texto, /\/no 3/)
})

test('rascunho agendado avisa a hora em que sairá', () => {
  const texto = formatDraft({
    id: 4, kind: 'conditional', chat_name: 'Jane Doe', body: 'traz o macbook',
    scheduled_for: 1756382400, check_prompt: 'ele já respondeu?',
  })
  assert.match(texto, /ele já respondeu\?/)
  assert.match(texto, /2025|2026|\d{2}\/\d{2}/)
})

test('a fila vazia diz que está vazia em vez de mostrar nada', () => {
  assert.match(formatQueue({ pending: [], scheduled: [] }), /nada/i)
})

test('a fila separa o que espera aprovação do que já está agendado', () => {
  const texto = formatQueue({
    pending: [{ id: 1, chat_name: 'John Doe', body: 'ok', scheduled_for: null, kind: 'message' }],
    scheduled: [{ id: 2, chat_name: 'Jane Doe', body: 'macbook', scheduled_for: 1756382400, kind: 'conditional' }],
  })
  assert.match(texto, /#1/)
  assert.match(texto, /#2/)
  assert.match(texto, /John Doe/)
  assert.match(texto, /Jane Doe/)
})

// --- envio, citação e desfazer ---

function montar({ run, sendText, deleteMessage } = {}) {
  const db = openDb(':memory:')
  const outbox = createOutbox({ db, now: () => 1000 })
  const enviadas = []
  const apagadas = []

  const wa = {
    sendText: sendText ?? (async (jid, texto, opts) => { enviadas.push({ jid, texto, quoted: opts?.quoted }); return 'WA-NOVO' }),
    deleteMessage: deleteMessage ?? (async (jid, waId) => { apagadas.push({ jid, waId }) }),
    state: () => 'open',
  }

  const wpp = createWpp({
    db,
    outbox,
    wa,
    run: run ?? (async () => ({ ok: true, text: 'ENVIAR: ninguém falou nada', sessionId: null, error: null })),
    config: { claudeBin: 'claude', agentCwd: '/tmp', timeoutMs: 1000 },
    now: () => 1000,
  })

  return { db, outbox, wpp, enviadas, apagadas }
}

test('envia o corpo aprovado para o jid do destino', async () => {
  const { outbox, wpp, enviadas } = montar()
  const d = outbox.create({ chatJid: '5@s.whatsapp.net', chatName: 'Jane Doe', body: 'traz o macbook' })
  const r = await wpp.send(outbox.get(d.id))

  assert.deepEqual(r, { ok: true, waId: 'WA-NOVO' })
  assert.equal(enviadas[0].jid, '5@s.whatsapp.net')
  assert.equal(enviadas[0].texto, 'traz o macbook')
})

test('responder de verdade: cita a mensagem original a partir do que foi gravado', async () => {
  const { db, outbox, wpp, enviadas } = montar()
  db.prepare("insert into chats (jid, name, kind, updated_at) values ('1-2@g.us', 'Líderes', 'group', 0)").run()
  db.prepare(`insert into messages (wa_id, chat_jid, sender_jid, from_me, ts, kind, body)
              values ('ORIG', '1-2@g.us', '9@s.whatsapp.net', 0, 10, 'text', 'e a migração?')`).run()

  const d = outbox.create({ chatJid: '1-2@g.us', body: 'semana que vem', quotedWaId: 'ORIG' })
  await wpp.send(outbox.get(d.id))

  assert.equal(enviadas[0].quoted.key.id, 'ORIG')
  assert.equal(enviadas[0].quoted.key.participant, '9@s.whatsapp.net')
  assert.equal(enviadas[0].quoted.message.conversation, 'e a migração?')
})

test('citar mensagem que não está no banco não impede o envio', async () => {
  const { outbox, wpp, enviadas } = montar()
  const d = outbox.create({ chatJid: '1-2@g.us', body: 'oi', quotedWaId: 'NAO-EXISTE' })
  const r = await wpp.send(outbox.get(d.id))
  assert.equal(r.ok, true)
  assert.equal(enviadas[0].quoted, undefined)
})

test('erro do whatsapp vira resultado, não exceção', async () => {
  const { outbox, wpp } = montar({ sendText: async () => { throw new Error('sem conexão') } })
  const d = outbox.create({ chatJid: '5@s.whatsapp.net', body: 'oi' })
  assert.deepEqual(await wpp.send(outbox.get(d.id)), { ok: false, error: 'sem conexão' })
})

test('undo apaga a última enviada e a tira da fila do undo', async () => {
  const { outbox, wpp, apagadas } = montar()
  const d = outbox.create({ chatJid: '5@s.whatsapp.net', chatName: 'Jane Doe', body: 'traz o macbook' })
  outbox.approve(d.id)
  outbox.markSent(d.id, 'WA-1')

  const r = await wpp.undo()
  assert.equal(r.ok, true)
  assert.deepEqual(apagadas, [{ jid: '5@s.whatsapp.net', waId: 'WA-1' }])
  assert.equal(outbox.get(d.id).status, 'deleted')
  assert.equal((await wpp.undo()).ok, false)
})

test('undo sem nada enviado explica em vez de estourar', async () => {
  const { wpp } = montar()
  const r = await wpp.undo()
  assert.equal(r.ok, false)
  assert.match(r.error, /nada/i)
})

test('undo recusado pelo whatsapp não marca como apagada', async () => {
  const { outbox, wpp } = montar({ deleteMessage: async () => { throw new Error('tarde demais') } })
  const d = outbox.create({ chatJid: '5@s.whatsapp.net', body: 'oi' })
  outbox.approve(d.id)
  outbox.markSent(d.id, 'WA-1')

  const r = await wpp.undo()
  assert.equal(r.ok, false)
  assert.match(r.error, /tarde demais/)
  assert.equal(outbox.get(d.id).status, 'sent')
})

// --- verificação condicional ---

test('a verificação recebe a conversa e devolve o veredito', async () => {
  let promptVisto = ''
  const { db, outbox, wpp } = montar({
    run: async ({ prompt }) => {
      promptVisto = prompt
      return { ok: true, text: 'PULAR: ele confirmou que traz', sessionId: null, error: null }
    },
  })
  db.prepare("insert into chats (jid, name, kind, updated_at) values ('5@s.whatsapp.net', 'Jane Doe', 'dm', 0)").run()
  db.prepare(`insert into messages (wa_id, chat_jid, sender_name, from_me, ts, kind, body)
              values ('M1', '5@s.whatsapp.net', 'Jane Doe', 0, 1500, 'text', 'pode deixar, levo o macbook')`).run()

  const d = outbox.create({
    chatJid: '5@s.whatsapp.net', chatName: 'Jane Doe', body: 'traz o macbook',
    kind: 'conditional', checkPrompt: 'ele já disse se traz?', scheduledFor: 2000,
  })

  const veredito = await wpp.decide(outbox.get(d.id))
  assert.deepEqual(veredito, { send: false, reason: 'ele confirmou que traz' })
  assert.match(promptVisto, /pode deixar, levo o macbook/)
  assert.match(promptVisto, /ele já disse se traz\?/)
  assert.match(promptVisto, /traz o macbook/)
})

test('claude fora do ar faz a verificação estourar, e o scheduler devolve para você', async () => {
  const { outbox, wpp } = montar({
    run: async () => ({ ok: false, text: '', sessionId: null, error: 'claude morreu' }),
  })
  const d = outbox.create({
    chatJid: '5@s.whatsapp.net', body: 'oi', kind: 'conditional', checkPrompt: 'respondeu?',
  })
  await assert.rejects(() => wpp.decide(outbox.get(d.id)), /claude morreu/)
})
