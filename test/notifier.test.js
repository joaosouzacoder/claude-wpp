import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier } from '../src/notifier.js'
import { formatNotification } from '../src/notifyRules.js'

function deckFalso(sessoes, respostas = {}) {
  return {
    sessoes,
    respostas,
    delivered: new Map(),
    falhar: false,
    async list() {
      if (this.falhar) throw new Error('tmux fora do ar')
      return this.sessoes.map((s) => ({ ...s }))
    },
    async lastReply(title) { return this.respostas[title] ?? null },
  }
}

function montar(sessoes, respostas, { ocupadas = [] } = {}) {
  const deck = deckFalso(sessoes, respostas)
  const avisos = []
  const logs = []
  const sessions = { get: (nome) => (ocupadas.includes(nome) ? { busy: true } : undefined) }
  const notifier = createNotifier({
    deck,
    sessions,
    notify: async (t) => { avisos.push(t) },
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  })
  return { deck, avisos, logs, notifier }
}

const r = (content, timestamp) => ({ content, timestamp })

test('primeira olhada só aprende o estado: oito sessões em waiting não viram oito avisos', async () => {
  const sessoes = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `s${i}`, status: 'waiting', lastActivityAt: 't0' }))
  const { avisos, notifier } = montar(sessoes, Object.fromEntries(sessoes.map((s) => [s.title, r('velha', 'T0')])))
  await notifier.tick()
  await notifier.tick()
  assert.deepEqual(avisos, [])
})

test('filho que imprime o sentinela vira aviso de conclusão com o resumo', async () => {
  const pai = { id: 'c', title: 'conductor-dw', status: 'waiting', lastActivityAt: 't0' }
  const filho = { id: 'f', title: 'daily-sync', status: 'running', parentId: 'c', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([pai, filho], { 'daily-sync': r('trabalhando', 'T0') })
  await notifier.tick()

  filho.status = 'waiting'
  filho.lastActivityAt = 't1'
  deck.respostas['daily-sync'] = r('pronto.\n===AGENTDECK_DONE=== status=ok summary=sync a cada 10min com testes', 'T1')
  await notifier.tick()

  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /✅ \[daily-sync\] \(filho de conductor-dw\) terminou: sync a cada 10min com testes/)
})

test('sentinela com status=fail vira aviso de falha', async () => {
  const s = { id: 'f', title: 'worker', status: 'running', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], {})
  await notifier.tick()
  s.status = 'waiting'
  s.lastActivityAt = 't1'
  deck.respostas.worker = r('===AGENTDECK_DONE=== status=fail summary=testes quebrando', 'T1')
  await notifier.tick()
  assert.match(avisos[0], /❌ \[worker\] falhou: testes quebrando/)
})

test('resposta nova sem sentinela vira "esperando você" com a prévia e como responder', async () => {
  const s = { id: 'c', title: 'conductor-dw', status: 'running', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], {})
  await notifier.tick()
  s.status = 'waiting'
  s.lastActivityAt = 't1'
  deck.respostas['conductor-dw'] = r('Qual bucket usar para as notas?', 'T1')
  await notifier.tick()
  assert.match(avisos[0], /⏸️ \[conductor-dw\] parou e está esperando você/)
  assert.match(avisos[0], /Qual bucket usar para as notas\?/)
  assert.match(avisos[0], /Responda com @conductor-dw/)
})

test('turno rápido que começa e acaba entre duas olhadas também avisa', async () => {
  const s = { id: 'c', title: 'conductor-dw', status: 'waiting', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], { 'conductor-dw': r('antiga', 'T0') })
  await notifier.tick()
  s.lastActivityAt = 't1'
  deck.respostas['conductor-dw'] = r('reagi ao evento do filho', 'T1')
  await notifier.tick()
  assert.equal(avisos.length, 1)
})

test('resposta que você já recebeu pela conversa não volta como aviso', async () => {
  const s = { id: 'c', title: 'conductor-dw', status: 'running', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], {})
  await notifier.tick()
  s.status = 'waiting'
  s.lastActivityAt = 't1'
  deck.respostas['conductor-dw'] = r('resposta ao seu pedido', 'T1')
  deck.delivered.set('conductor-dw', 'T1')
  await notifier.tick()
  assert.deepEqual(avisos, [])
})

test('sessão ocupada por uma conversa do WhatsApp é ignorada enquanto a conversa dura', async () => {
  const s = { id: 'c', title: 'conductor-dw', status: 'running', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], {}, { ocupadas: ['conductor-dw'] })
  await notifier.tick()
  s.status = 'waiting'
  s.lastActivityAt = 't1'
  deck.respostas['conductor-dw'] = r('resposta ao seu pedido', 'T1')
  await notifier.tick()
  assert.deepEqual(avisos, [])
})

test('a mesma resposta não é avisada duas vezes', async () => {
  const s = { id: 'c', title: 'x', status: 'running', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], {})
  await notifier.tick()
  s.status = 'waiting'
  s.lastActivityAt = 't1'
  deck.respostas.x = r('uma vez só', 'T1')
  await notifier.tick()
  s.lastActivityAt = 't2' // shell em background mexendo no pane, sem resposta nova
  await notifier.tick()
  assert.equal(avisos.length, 1)
})

test('sessão que entra em erro avisa uma vez', async () => {
  const s = { id: 'c', title: 'x', status: 'waiting', lastActivityAt: 't0' }
  const { avisos, notifier } = montar([s], {})
  await notifier.tick()
  s.status = 'error'
  await notifier.tick()
  await notifier.tick()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /⚠️ \[x\] entrou em erro/)
})

test('sessão nova no deck não gera aviso só por aparecer', async () => {
  const sessoes = [{ id: 'a', title: 'a', status: 'waiting', lastActivityAt: 't0' }]
  const { deck, avisos, notifier } = montar(sessoes, {})
  await notifier.tick()
  sessoes.push({ id: 'b', title: 'b', status: 'waiting', lastActivityAt: 't0' })
  deck.respostas.b = r('olá', 'T0')
  await notifier.tick()
  assert.deepEqual(avisos, [])
})

test('agent-deck fora do ar vira uma linha de log por queda, não uma por olhada', async () => {
  const { deck, logs, avisos, notifier } = montar([{ id: 'a', title: 'a', status: 'waiting', lastActivityAt: 't0' }], {})
  await notifier.tick()
  deck.falhar = true
  await notifier.tick()
  await notifier.tick()
  await notifier.tick()
  deck.falhar = false
  await notifier.tick()
  assert.equal(logs.filter((l) => /tmux fora do ar/.test(l)).length, 1)
  assert.equal(logs.filter((l) => /voltou/.test(l)).length, 1)
  assert.deepEqual(avisos, [])
})

test('regra que devolve null silencia o evento', async () => {
  const s = { id: 'c', title: 'barulhenta', status: 'running', lastActivityAt: 't0' }
  const deck = deckFalso([s], {})
  const avisos = []
  const notifier = createNotifier({
    deck,
    sessions: { get: () => undefined },
    notify: async (t) => { avisos.push(t) },
    rules: (ev) => (ev.title === 'barulhenta' ? null : formatNotification(ev)),
  })
  await notifier.tick()
  s.status = 'waiting'
  s.lastActivityAt = 't1'
  deck.respostas.barulhenta = r('bla', 'T1')
  await notifier.tick()
  assert.deepEqual(avisos, [])
})

test('prévia longa é cortada para não inundar o WhatsApp', () => {
  const texto = formatNotification({ kind: 'waiting', title: 'x', addressable: true, content: 'a'.repeat(5000) })
  assert.ok(texto.length < 900)
  assert.match(texto, /…/)
})

test('sessão com nome fora do padrão não sugere um @ que o roteador recusaria', () => {
  const texto = formatNotification({ kind: 'waiting', title: 'Consult Codex', addressable: false, content: 'oi' })
  assert.doesNotMatch(texto, /Responda com @/)
})

function turno(s, deck, conteudo, ts, atividade) {
  s.status = 'waiting'
  s.lastActivityAt = atividade
  deck.respostas[s.title] = r(conteudo, ts)
}

test('heartbeat do conductor sem NEED fica em silêncio', async () => {
  const s = { id: 'c', title: 'conductor-base', status: 'waiting', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], { 'conductor-base': r('velha', 'T0') })
  await notifier.tick()
  turno(s, deck, '[STATUS] All clear.', 'T1', 't1')
  await notifier.tick()
  assert.deepEqual(avisos, [])
})

test('heartbeat com NEED avisa só as NEED, não o relatório inteiro', async () => {
  const s = { id: 'c', title: 'conductor-base', status: 'waiting', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], { 'conductor-base': r('velha', 'T0') })
  await notifier.tick()
  turno(s, deck, '[STATUS] Tudo igual. Nenhuma resposta automática.\n\nAUTO: web - usei o middleware\nNEED: base-backend - staging ou prod?', 'T1', 't1')
  await notifier.tick()
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /🔔 \[conductor-base\] precisa de você:\n• base-backend - staging ou prod\?/)
  assert.doesNotMatch(avisos[0], /AUTO:|Tudo igual/)
})

test('a mesma NEED repetida a cada heartbeat avisa uma vez só; NEED diferente avisa de novo', async () => {
  const s = { id: 'c', title: 'conductor-base', status: 'waiting', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], { 'conductor-base': r('velha', 'T0') })
  await notifier.tick()
  const repetida = '[STATUS] Tudo igual.\n\nNEED: base-web, base-backend continuam parados, esperando uma tarefa sua.'
  turno(s, deck, repetida, 'T1', 't1')
  await notifier.tick()
  turno(s, deck, repetida, 'T2', 't2')
  await notifier.tick()
  turno(s, deck, repetida, 'T3', 't3')
  await notifier.tick()
  assert.equal(avisos.length, 1)
  turno(s, deck, '[STATUS] Mudou.\n\nNEED: base-web - quebrou o build', 'T4', 't4')
  await notifier.tick()
  assert.equal(avisos.length, 2)
  assert.match(avisos[1], /quebrou o build/)
})

test('NEED que some e volta avisa de novo quando volta', async () => {
  const s = { id: 'c', title: 'conductor-base', status: 'waiting', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], { 'conductor-base': r('velha', 'T0') })
  await notifier.tick()
  turno(s, deck, '[STATUS] x\nNEED: decidir bucket', 'T1', 't1')
  await notifier.tick()
  turno(s, deck, '[STATUS] All clear.', 'T2', 't2')
  await notifier.tick()
  turno(s, deck, '[STATUS] x\nNEED: decidir bucket', 'T3', 't3')
  await notifier.tick()
  assert.equal(avisos.length, 2)
})
