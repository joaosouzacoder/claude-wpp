import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWatcher } from '../src/watcher.js'

const T0 = Date.parse('2026-09-24T11:00:00.000Z')
const em = (segundos) => new Date(T0 + segundos * 1000).toISOString()

function montar({ entradas = [], sessao = {}, agora = T0 + 600000 } = {}) {
  const enviados = []
  const sessoes = [{ name: 'infra', cwd: '/home/jgabr', claudeSessionId: 'sid', busy: false, ...sessao }]
  const watcher = createWatcher({
    sessions: { list: () => sessoes },
    enviar: async (nome, texto) => { enviados.push([nome, texto]) },
    ler: async ({ desde }) => entradas.filter((e) => !desde || e.timestamp > desde),
    now: () => agora,
  })
  return { watcher, enviados, sessoes }
}

test('a primeira olhada não despeja o histórico no WhatsApp', async () => {
  const { watcher, enviados } = montar({
    entradas: [
      { tipo: 'user', texto: '<task-notification>\npronto', timestamp: em(10) },
      { tipo: 'assistant', texto: 'resposta antiga', timestamp: em(20) },
    ],
  })

  await watcher.passar()
  assert.deepEqual(enviados, [])
})

test('o que a sessão disse sozinha, depois de um subagente terminar, é encaminhado', async () => {
  // Foi exatamente o caso dele: o turno acabou às 11:02, o subagente respondeu
  // às 11:03 e a resposta ficou parada na sessão.
  const { watcher, enviados } = montar({
    entradas: [
      { tipo: 'user', texto: '<task-notification>\n<task-id>abc</task-id>', timestamp: em(200) },
      { tipo: 'assistant', texto: 'A conta tem 23 instâncias EC2 em us-east-1.', timestamp: em(210) },
    ],
  })

  watcher.marcar('infra', em(100))
  await watcher.passar()

  assert.deepEqual(enviados, [['infra', 'A conta tem 23 instâncias EC2 em us-east-1.']])
})

test('resposta ao que ele digitou no terminal não é reenviada pro WhatsApp', async () => {
  const { watcher, enviados } = montar({
    entradas: [
      { tipo: 'user', texto: 'listou?', timestamp: em(300) },
      { tipo: 'assistant', texto: 'Listou, sim.', timestamp: em(305) },
    ],
  })

  watcher.marcar('infra', em(100))
  await watcher.passar()

  assert.deepEqual(enviados, [], 'ele está lendo isso no terminal')
})

test('não encaminha nada enquanto um turno do bot está em voo', async () => {
  const { watcher, enviados } = montar({
    sessao: { busy: true },
    entradas: [
      { tipo: 'user', texto: '<task-notification>', timestamp: em(200) },
      { tipo: 'assistant', texto: 'seria duplicado', timestamp: em(210) },
    ],
  })

  watcher.marcar('infra', em(100))
  await watcher.passar()
  assert.deepEqual(enviados, [], 'esse caminho já entrega a resposta do turno')
})

test('espera a sessão sossegar, e depois manda só a última', async () => {
  const entradas = [
    { tipo: 'user', texto: '<task-notification>', timestamp: em(200) },
    { tipo: 'assistant', texto: 'primeira parte', timestamp: em(205) },
  ]
  const enviados = []
  let agora = Date.parse(em(208))
  const watcher = createWatcher({
    sessions: { list: () => [{ name: 'infra', cwd: '/x', claudeSessionId: 'sid', busy: false }] },
    enviar: async (nome, texto) => { enviados.push(texto) },
    ler: async ({ desde }) => entradas.filter((e) => !desde || e.timestamp > desde),
    now: () => agora,
  })
  watcher.marcar('infra', em(100))

  await watcher.passar()
  assert.deepEqual(enviados, [], 'acabou de escrever: ainda pode vir mais')

  entradas.push({ tipo: 'assistant', texto: 'resposta completa', timestamp: em(212) })
  agora = Date.parse(em(240))
  await watcher.passar()
  assert.deepEqual(enviados, ['resposta completa'])

  agora = Date.parse(em(300))
  await watcher.passar()
  assert.deepEqual(enviados, ['resposta completa'], 'e não repete na próxima passada')
})

test('uma sessão que falha na leitura não derruba as outras', async () => {
  const enviados = []
  const watcher = createWatcher({
    sessions: {
      list: () => [
        { name: 'quebrada', cwd: '/x', claudeSessionId: 'a', busy: false },
        { name: 'boa', cwd: '/y', claudeSessionId: 'b', busy: false },
      ],
    },
    enviar: async (nome, texto) => { enviados.push([nome, texto]) },
    ler: async ({ sessionId, desde }) => {
      if (sessionId === 'a') throw new Error('sem transcrição')
      return desde
        ? [
            { tipo: 'user', texto: '<task-notification>', timestamp: em(200) },
            { tipo: 'assistant', texto: 'terminei', timestamp: em(205) },
          ]
        : []
    },
    now: () => T0 + 600000,
  })
  watcher.marcar('quebrada', em(100))
  watcher.marcar('boa', em(100))

  await watcher.passar()
  assert.deepEqual(enviados, [['boa', 'terminei']])
})
