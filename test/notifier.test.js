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

// Stands in for the file the daemon keeps across restarts.
function memoriaFalsa() {
  let salvo = null
  return { load: () => structuredClone(salvo), save: (v) => { salvo = structuredClone(v) } }
}

function montar(sessoes, respostas, { ocupadas = [], maxChars = 3500, memoria = memoriaFalsa() } = {}) {
  const deck = deckFalso(sessoes, respostas)
  const avisos = []
  const logs = []
  const sessions = { get: (nome) => (ocupadas.includes(nome) ? { busy: true } : undefined) }
  const notifier = createNotifier({
    deck,
    sessions,
    notify: async (t) => { avisos.push(t) },
    maxChars,
    memoria,
    log: { info: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
  })
  return { deck, avisos, logs, notifier, memoria, sessions }
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

test('resposta longa chega inteira, sem corte', () => {
  const conteudo = Array.from({ length: 200 }, (_, i) => `linha ${i} do relatório`).join('\n')
  const texto = formatNotification({ kind: 'waiting', title: 'x', addressable: true, content: conteudo })
  assert.ok(texto.includes(conteudo))
  assert.doesNotMatch(texto, /…/)
})

test('aviso maior que uma mensagem do WhatsApp vai em várias, quebrado entre linhas', async () => {
  const s = { id: 'c', title: 'conductor-cw', status: 'running', lastActivityAt: 't0' }
  const { deck, avisos, notifier } = montar([s], {}, { maxChars: 300 })
  await notifier.tick()
  const linhas = Array.from({ length: 60 }, (_, i) => `${i}. **Nada foi testado** contra o binário real`)
  s.status = 'waiting'
  s.lastActivityAt = 't1'
  deck.respostas['conductor-cw'] = r(linhas.join('\n'), 'T1')
  await notifier.tick()
  assert.ok(avisos.length > 1)
  assert.ok(avisos.every((a) => a.length <= 300))
  const junto = avisos.join('\n')
  for (const linha of linhas) assert.ok(junto.includes(linha), `faltou: ${linha}`)
  assert.doesNotMatch(junto, /…/)
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
  const web = { id: 'w', title: 'base-web', status: 'waiting', lastActivityAt: 'w0', parentId: 'c' }
  const backend = { id: 'b', title: 'base-backend', status: 'waiting', lastActivityAt: 'b0', parentId: 'c' }
  const { deck, avisos, notifier } = montar([s, web, backend], { 'conductor-base': r('velha', 'T0') })
  await notifier.tick()
  const repetida = '[STATUS] Tudo igual.\n\nNEED: base-web, base-backend continuam parados, esperando uma tarefa sua.'
  turno(s, deck, repetida, 'T1', 't1')
  await notifier.tick()
  turno(s, deck, repetida, 'T2', 't2')
  await notifier.tick()
  turno(s, deck, repetida, 'T3', 't3')
  await notifier.tick()
  assert.equal(avisos.length, 1)
  // base-web got a task and ran; what it needs now is a new matter.
  web.lastActivityAt = 'w1'
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

// The shapes below are what conductor-infra and conductor-base actually sent,
// one heartbeat apart: the same pending item, worded differently each time.
const INFRA = [
  'aws-conta-antiga - a investigação do vigia de integridade terminou e ele está esperando sua decisão sobre as correções:',
  'aws-conta-antiga - ainda aguarda sua decisão sobre as correções do vigia de integridade. O `apt-daily-upgrade` volta a rodar amanhã às 06:12 BRT, em cima do ciclo das 06h.',
  'aws-conta-antiga - ainda espera sua decisão sobre as correções do vigia de integridade. O `apt-daily-upgrade` volta a rodar amanhã às 06:12 BRT, bem em cima do ciclo das 06h.',
  'aws-conta-antiga - ainda espera sua decisão sobre as correções do vigia de integridade. A atualização automática do Ubuntu (`apt-daily-upgrade`) está agendada para amanhã às 06:12 BRT, bem no meio do ciclo das 06h. É a mesma situação que derrubou o ciclo de hoje.',
  'aws-conta-antiga - ainda espera sua decisão sobre as correções do vigia de integridade. Amanhã às 06:12 BRT a atualização automática do Ubuntu (`apt-daily-upgrade`) roda de novo, bem em cima do ciclo das 06h.',
]
const BASE = [
  'base-backoffice, base-web e base-backend continuam parados, esperando uma tarefa sua.',
  'base-backoffice, base-web e base-backend continuam parados, esperando uma tarefa sua. Se ainda não houver tarefa, posso parar as três sessões para os heartbeats pararem de avisar.',
]

function infra() {
  const c = { id: 'ci', title: 'conductor-infra', status: 'waiting', lastActivityAt: 't0' }
  const conta = { id: 'aca', title: 'aws-conta-antiga', status: 'waiting', lastActivityAt: '2026-09-11T12:04:10Z', parentId: 'ci' }
  const swat = { id: 'swat', title: 'aws-swat', status: 'waiting', lastActivityAt: '2026-09-11T11:37:31Z', parentId: 'ci' }
  return { c, conta, swat }
}

async function heartbeats(c, deck, notifier, linhas, desde = 1) {
  for (const [i, linha] of linhas.entries()) {
    turno(c, deck, `[STATUS] Heartbeat.\n\nNEED: ${linha}`, `T${desde + i}`, `t${desde + i}`)
    await notifier.tick()
  }
}

test('conductor que reescreve a mesma pendência a cada heartbeat avisa uma vez só', async () => {
  const { c, conta, swat } = infra()
  const { deck, avisos, notifier } = montar([c, conta, swat], { 'conductor-infra': r('velha', 'T0') })
  await notifier.tick()
  await heartbeats(c, deck, notifier, INFRA)
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /🔔 \[conductor-infra\] precisa de você:\n• aws-conta-antiga/)
})

test('a lista de filhos parados com uma frase a mais não é pendência nova', async () => {
  const c = { id: 'cb', title: 'conductor-base', status: 'waiting', lastActivityAt: 't0' }
  const filhos = ['base-backoffice', 'base-web', 'base-backend'].map((t, i) => ({ id: `b${i}`, title: t, status: 'waiting', lastActivityAt: '2026-09-11T01:56:33Z', parentId: 'cb' }))
  const { deck, avisos, notifier } = montar([c, ...filhos], { 'conductor-base': r('velha', 'T0') })
  await notifier.tick()
  await heartbeats(c, deck, notifier, [BASE[0], BASE[1], BASE[0]])
  assert.equal(avisos.length, 1)
})

test('outra sessão passando a precisar de você avisa, e só dela', async () => {
  const { c, conta, swat } = infra()
  const { deck, avisos, notifier } = montar([c, conta, swat], { 'conductor-infra': r('velha', 'T0') })
  await notifier.tick()
  await heartbeats(c, deck, notifier, [INFRA[0]])
  turno(c, deck, `[STATUS] Heartbeat.\n\nNEED: ${INFRA[1]}\nNEED: aws-swat - o deploy pede aprovação manual.`, 'T9', 't9')
  await notifier.tick()
  assert.equal(avisos.length, 2)
  assert.match(avisos[1], /aws-swat - o deploy pede aprovação manual/)
  assert.doesNotMatch(avisos[1], /aws-conta-antiga/)
})

test('pendência resolvida que volta a precisar de você avisa de novo', async () => {
  const { c, conta, swat } = infra()
  const { deck, avisos, notifier } = montar([c, conta, swat], { 'conductor-infra': r('velha', 'T0') })
  await notifier.tick()
  await heartbeats(c, deck, notifier, [INFRA[0], INFRA[1]])
  // You answered in the pane and the session ran with it.
  conta.lastActivityAt = '2026-09-11T13:40:00Z'
  await heartbeats(c, deck, notifier, [INFRA[2]], 5)
  assert.equal(avisos.length, 2)
})

test('falar com o conductor pelo WhatsApp encerra o aviso: a próxima pendência avisa de novo', async () => {
  const { c, conta, swat } = infra()
  const { deck, avisos, notifier, sessions } = montar([c, conta, swat], { 'conductor-infra': r('velha', 'T0') }, { ocupadas: [] })
  await notifier.tick()
  await heartbeats(c, deck, notifier, [INFRA[0]])
  sessions.get = (nome) => (nome === 'conductor-infra' ? { busy: true } : undefined)
  await notifier.tick()
  sessions.get = () => undefined
  await heartbeats(c, deck, notifier, [INFRA[1]], 5)
  assert.equal(avisos.length, 2)
})

test('reiniciar o daemon não repete a pendência já avisada', async () => {
  const { c, conta, swat } = infra()
  const primeira = montar([c, conta, swat], { 'conductor-infra': r('velha', 'T0') })
  await primeira.notifier.tick()
  await heartbeats(c, primeira.deck, primeira.notifier, [INFRA[0]])
  assert.equal(primeira.avisos.length, 1)

  const depois = montar([c, conta, swat], { 'conductor-infra': primeira.deck.respostas['conductor-infra'] }, { memoria: primeira.memoria })
  await depois.notifier.tick()
  await heartbeats(c, depois.deck, depois.notifier, [INFRA[1], INFRA[2]], 5)
  assert.deepEqual(depois.avisos, [])
})

test('"esperando você" não se repete para a mesma espera, nem depois de reiniciar', async () => {
  const s = { id: 'c', title: 'conductor-dw', status: 'running', lastActivityAt: 't0' }
  const primeira = montar([s], {})
  await primeira.notifier.tick()
  turno(s, primeira.deck, 'Qual bucket usar?', 'T1', 't1')
  await primeira.notifier.tick()
  s.lastActivityAt = 't2'
  await primeira.notifier.tick()
  assert.equal(primeira.avisos.length, 1)

  const depois = montar([s], { 'conductor-dw': r('Qual bucket usar?', 'T1') }, { memoria: primeira.memoria })
  await depois.notifier.tick()
  s.lastActivityAt = 't3'
  await depois.notifier.tick()
  assert.deepEqual(depois.avisos, [])
})
