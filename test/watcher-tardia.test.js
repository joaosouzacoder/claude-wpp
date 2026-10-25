import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWatcher } from '../src/watcher.js'

// A turn the bot stopped waiting on still owes him its answer. From the mark
// the bot left, the session's next settled words go to him — no machine
// notice required, and only once.
const T0 = Date.parse('2026-10-25T10:00:00.000Z')
const em = (s) => new Date(T0 + s * 1000).toISOString()

function montar({ entradas, sessao, agora }) {
  const enviados = []
  const limpezas = []
  const sessoes = [{ name: 'wpp', cwd: '/home/user', claudeSessionId: 'sid', busy: false, entregaTardia: null, ...sessao }]
  const watcher = createWatcher({
    sessions: {
      list: () => sessoes,
      foiPromptDoBot: () => false,
      limparEntregaTardia: (nome) => { limpezas.push(nome); sessoes[0].entregaTardia = null },
    },
    enviar: async (nome, texto) => { enviados.push([nome, texto]) },
    ler: async ({ desde }) => entradas.filter((e) => !desde || e.timestamp > desde),
    now: () => agora,
  })
  return { watcher, enviados, limpezas, sessoes }
}

test('com a marca de entrega tardia, a próxima fala sossegada vai pro dono, mesmo sem aviso de máquina', async () => {
  const c = montar({
    sessao: { entregaTardia: em(100) },
    entradas: [
      { tipo: 'assistant', texto: 'Vou pedir ao swat.', timestamp: em(100) },
      { tipo: 'assistant', texto: 'Resultado: 36 bytes cada.', timestamp: em(400) },
    ],
    agora: T0 + 600_000,
  })
  await c.watcher.passar()
  assert.deepEqual(c.enviados, [['wpp', 'Resultado: 36 bytes cada.']])
  assert.deepEqual(c.limpezas, ['wpp'], 'a marca é consumida')

  await c.watcher.passar()
  assert.equal(c.enviados.length, 1, 'e não repete')
})

test('enquanto a sessão ainda está escrevendo, espera', async () => {
  const c = montar({
    sessao: { entregaTardia: em(100) },
    entradas: [{ tipo: 'assistant', texto: 'escrevendo…', timestamp: em(400) }],
    agora: T0 + 402_000,
  })
  await c.watcher.passar()
  assert.deepEqual(c.enviados, [])
  assert.deepEqual(c.limpezas, [], 'a marca fica até algo sossegar')
})

test('sem fala nova depois da marca, nada sai e a marca fica', async () => {
  const c = montar({
    sessao: { entregaTardia: em(100) },
    entradas: [{ tipo: 'assistant', texto: 'Vou pedir ao swat.', timestamp: em(100) }],
    agora: T0 + 900_000,
  })
  await c.watcher.passar()
  assert.deepEqual(c.enviados, [])
  assert.equal(c.sessoes[0].entregaTardia, em(100))
})

test('um turno nosso em voo tem prioridade: a marca não é lida enquanto busy', async () => {
  const c = montar({
    sessao: { entregaTardia: em(100), busy: true },
    entradas: [{ tipo: 'assistant', texto: 'resposta', timestamp: em(400) }],
    agora: T0 + 900_000,
  })
  await c.watcher.passar()
  assert.deepEqual(c.enviados, [])
})
