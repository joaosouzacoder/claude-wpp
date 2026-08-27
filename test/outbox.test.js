import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'

let relogio = 1000
const novo = () => {
  relogio = 1000
  const db = openDb(':memory:')
  return { db, outbox: createOutbox({ db, now: () => relogio }) }
}

const rascunho = (extra = {}) => ({
  chatJid: '1-2@g.us',
  chatName: 'Líderes',
  body: 'a migração fica pra semana que vem',
  ...extra,
})

test('rascunho nasce pendente, nunca aprovado', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  assert.equal(d.status, 'pending')
  assert.equal(d.kind, 'message')
  assert.equal(d.created_at, 1000)
})

test('recusa rascunho sem destino ou sem texto', () => {
  const { outbox } = novo()
  assert.throws(() => outbox.create(rascunho({ chatJid: '' })), /destino/)
  assert.throws(() => outbox.create(rascunho({ body: '   ' })), /texto/)
})

test('condicional exige a pergunta de verificação', () => {
  const { outbox } = novo()
  assert.throws(() => outbox.create(rascunho({ kind: 'conditional' })), /verificação/)
  const d = outbox.create(rascunho({ kind: 'conditional', checkPrompt: 'ele já respondeu?' }))
  assert.equal(d.check_prompt, 'ele já respondeu?')
})

test('não conheço outros tipos de tarefa', () => {
  const { outbox } = novo()
  assert.throws(() => outbox.create(rascunho({ kind: 'dançar' })), /tipo/)
})

test('pendente não é entregável: só aparece em pending()', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  assert.deepEqual(outbox.pending().map((r) => r.id), [d.id])
  assert.deepEqual(outbox.due(9999), [])
})

test('aprovar sem horário deixa pronto para sair agora', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  relogio = 1001
  const aprovado = outbox.approve(d.id)
  assert.equal(aprovado.status, 'approved')
  assert.equal(aprovado.decided_at, 1001)
  assert.deepEqual(outbox.due(1001).map((r) => r.id), [d.id])
})

test('aprovar com horário só vence na hora marcada', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho({ scheduledFor: 5000 }))
  outbox.approve(d.id)
  assert.deepEqual(outbox.due(4999), [])
  assert.deepEqual(outbox.due(5000).map((r) => r.id), [d.id])
})

test('agendado aprovado aparece na lista de agendamentos', () => {
  const { outbox } = novo()
  const agora = outbox.create(rascunho())
  const depois = outbox.create(rascunho({ scheduledFor: 5000 }))
  outbox.approve(agora.id)
  outbox.approve(depois.id)
  assert.deepEqual(outbox.scheduled().map((r) => r.id), [depois.id])
})

test('recusar tira da fila para sempre', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  assert.equal(outbox.reject(d.id).status, 'rejected')
  assert.deepEqual(outbox.pending(), [])
  assert.deepEqual(outbox.due(9999), [])
})

test('não dá para aprovar o que já foi decidido', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  outbox.reject(d.id)
  assert.equal(outbox.approve(d.id), null)
})

test('não dá para aprovar duas vezes', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  outbox.approve(d.id)
  assert.equal(outbox.approve(d.id), null)
})

test('cancelar mata um agendamento já aprovado', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho({ scheduledFor: 5000 }))
  outbox.approve(d.id)
  assert.equal(outbox.cancel(d.id).status, 'canceled')
  assert.deepEqual(outbox.due(9999), [])
})

test('enviado sai da fila e guarda o id da mensagem, que é o que o /undo usa', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  outbox.approve(d.id)
  relogio = 2000
  outbox.markSent(d.id, 'WA123')
  const r = outbox.get(d.id)
  assert.equal(r.status, 'sent')
  assert.equal(r.sent_wa_id, 'WA123')
  assert.equal(r.sent_at, 2000)
  assert.deepEqual(outbox.due(9999), [])
})

test('falha de envio guarda o motivo e não fica tentando para sempre', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  outbox.approve(d.id)
  outbox.markFailed(d.id, 'sem conexão')
  assert.equal(outbox.get(d.id).status, 'failed')
  assert.equal(outbox.get(d.id).reason, 'sem conexão')
  assert.deepEqual(outbox.due(9999), [])
})

test('pulado pela verificação registra o porquê', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho({ kind: 'conditional', checkPrompt: 'já respondeu?' }))
  outbox.approve(d.id)
  outbox.markSkipped(d.id, 'ele confirmou ontem que traz')
  assert.equal(outbox.get(d.id).status, 'skipped')
  assert.equal(outbox.get(d.id).reason, 'ele confirmou ontem que traz')
})

test('atrasado demais volta a pendente em vez de disparar fora de hora', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho({ scheduledFor: 5000 }))
  outbox.approve(d.id)
  const r = outbox.reopen(d.id, 'o serviço estava fora do ar')
  assert.equal(r.status, 'pending')
  assert.deepEqual(outbox.pending().map((x) => x.id), [d.id])
  assert.deepEqual(outbox.due(9999), [])
})

test('lastSent devolve a última enviada, que é a que o /undo apaga', () => {
  const { outbox } = novo()
  const a = outbox.create(rascunho({ body: 'primeira' }))
  const b = outbox.create(rascunho({ body: 'segunda' }))
  outbox.approve(a.id); outbox.approve(b.id)
  relogio = 2000; outbox.markSent(a.id, 'WA-A')
  relogio = 2001; outbox.markSent(b.id, 'WA-B')
  assert.equal(outbox.lastSent().sent_wa_id, 'WA-B')
})

test('depois de apagada, a mensagem não é mais candidata a /undo', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  outbox.approve(d.id)
  outbox.markSent(d.id, 'WA-A')
  outbox.markDeleted(d.id)
  assert.equal(outbox.lastSent(), null)
})

test('sobrevive ao restart: o que estava aprovado continua vencendo', () => {
  const db = openDb(':memory:')
  const primeiro = createOutbox({ db, now: () => 1000 })
  const d = primeiro.create(rascunho({ scheduledFor: 5000 }))
  primeiro.approve(d.id)

  const segundo = createOutbox({ db, now: () => 6000 })
  assert.deepEqual(segundo.due(6000).map((r) => r.id), [d.id])
  db.close()
})

// --- edição ---
// Editar não pode virar um jeito de fazer sair um texto que ninguém aprovou:
// mexer no corpo de algo já aprovado tem que devolver a decisão para o dono.

test('editar troca o corpo de um rascunho pendente', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  const r = outbox.edit(d.id, 'passando pra lembrar de novo')
  assert.equal(r.body, 'passando pra lembrar de novo')
  assert.equal(r.status, 'pending')
})

test('editar preserva horário, verificação e citação', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho({
    kind: 'conditional', checkPrompt: 'já respondeu?', scheduledFor: 5000, quotedWaId: 'ORIG',
  }))
  const r = outbox.edit(d.id, 'outro texto')
  assert.equal(r.scheduled_for, 5000)
  assert.equal(r.check_prompt, 'já respondeu?')
  assert.equal(r.quoted_wa_id, 'ORIG')
  assert.equal(r.kind, 'conditional')
})

test('editar o que já foi aprovado devolve para pendente, exigindo novo ok', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho({ scheduledFor: 5000 }))
  outbox.approve(d.id)
  const r = outbox.edit(d.id, 'texto novo')
  assert.equal(r.status, 'pending')
  assert.equal(r.body, 'texto novo')
  assert.deepEqual(outbox.due(9999), [])
})

test('não dá para editar o que já saiu', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  outbox.approve(d.id)
  outbox.markSent(d.id, 'WA-1')
  assert.equal(outbox.edit(d.id, 'tarde demais'), null)
  assert.equal(outbox.get(d.id).body, rascunho().body)
})

test('não dá para editar o que foi descartado', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  outbox.reject(d.id)
  assert.equal(outbox.edit(d.id, 'nao'), null)
})

test('editar com texto vazio não apaga o rascunho', () => {
  const { outbox } = novo()
  const d = outbox.create(rascunho())
  assert.throws(() => outbox.edit(d.id, '   '), /texto/)
  assert.equal(outbox.get(d.id).body, rascunho().body)
})

test('editar rascunho inexistente devolve nulo', () => {
  const { outbox } = novo()
  assert.equal(outbox.edit(999, 'oi'), null)
})
