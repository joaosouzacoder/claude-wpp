import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createWatcher } from '../src/watcher.js'

const T0 = Date.parse('2026-09-24T11:00:00.000Z')
const em = (segundos) => new Date(T0 + segundos * 1000).toISOString()

const PEDIDO_DO_WPP = 'peça pro conta-antiga listar as ec2'
const PEDIDO_DELE = 'liste os usuários do IAM'

function montar({ entradas = [], sessao = {}, agora = T0 + 600000, nossos = [PEDIDO_DO_WPP] } = {}) {
  const enviados = []
  const sessoes = [{ name: 'infra', cwd: '/home/user', claudeSessionId: 'sid', busy: false, ...sessao }]
  const watcher = createWatcher({
    sessions: {
      list: () => sessoes,
      foiPromptDoBot: (nome, texto) => nossos.some((p) => texto.trim().startsWith(p)),
    },
    enviar: async (nome, texto) => { enviados.push([nome, texto]) },
    ler: async ({ desde }) => entradas.filter((e) => !desde || e.timestamp > desde),
    now: () => agora,
  })
  return { watcher, enviados, sessoes }
}

test('a primeira olhada não despeja o histórico no WhatsApp', async () => {
  const { watcher, enviados } = montar({
    entradas: [
      { tipo: 'user', texto: PEDIDO_DO_WPP, timestamp: em(10) },
      { tipo: 'user', texto: '<task-notification>\npronto', timestamp: em(15) },
      { tipo: 'assistant', texto: 'resposta antiga', timestamp: em(20) },
    ],
  })

  await watcher.passar()
  assert.deepEqual(enviados, [])
})

test('subagente que terminou depois de um pedido do WhatsApp é encaminhado', async () => {
  // O caso dele: o turno acabou dizendo "passei o pedido", o subagente
  // respondeu um minuto depois e a resposta ficou parada na sessão.
  const { watcher, enviados } = montar({
    entradas: [
      { tipo: 'user', texto: PEDIDO_DO_WPP, timestamp: em(100) },
      { tipo: 'assistant', texto: 'Passei o pedido pro conta-antiga.', timestamp: em(110) },
      { tipo: 'user', texto: '<task-notification>\n<task-id>abc</task-id>', timestamp: em(200) },
      { tipo: 'assistant', texto: 'A conta tem 23 instâncias EC2 em us-east-1.', timestamp: em(210) },
    ],
  })

  watcher.marcar('infra', em(90))
  await watcher.passar()

  assert.deepEqual(enviados, [['infra', 'A conta tem 23 instâncias EC2 em us-east-1.']])
})

test('o mesmo, pedido pelo terminal do Mac dele, não vai pro WhatsApp', async () => {
  const { watcher, enviados } = montar({
    entradas: [
      { tipo: 'user', texto: PEDIDO_DELE, timestamp: em(100) },
      { tipo: 'assistant', texto: 'Passei pro swat.', timestamp: em(110) },
      { tipo: 'user', texto: '<task-notification>\n<task-id>abc</task-id>', timestamp: em(200) },
      { tipo: 'assistant', texto: 'O swat respondeu: 14 usuários.', timestamp: em(210) },
    ],
  })

  watcher.marcar('infra', em(90))
  await watcher.passar()

  assert.deepEqual(enviados, [], 'ele está lendo isso na tela dele')
})

test('ele digitando no meio de uma cadeia nossa cala o resto dela', async () => {
  const { watcher, enviados } = montar({
    entradas: [
      { tipo: 'user', texto: PEDIDO_DELE, timestamp: em(300) },
      { tipo: 'user', texto: '<task-notification>', timestamp: em(400) },
      { tipo: 'assistant', texto: 'resultado do que ELE pediu', timestamp: em(410) },
    ],
  })

  // Vinha de um pedido nosso, mas ele assumiu a conversa no terminal.
  watcher.marcar('infra', em(200), { doBot: true, sozinha: true })
  await watcher.passar()

  assert.deepEqual(enviados, [])
})

test('a resposta do próprio turno não é reenviada', async () => {
  const { watcher, enviados } = montar({
    entradas: [
      { tipo: 'user', texto: PEDIDO_DO_WPP, timestamp: em(100) },
      { tipo: 'assistant', texto: 'Passei o pedido.', timestamp: em(110) },
    ],
  })

  watcher.marcar('infra', em(90))
  await watcher.passar()

  assert.deepEqual(enviados, [], 'o caminho do turno já entregou essa')
})

test('a cadeia continua nossa mesmo quando o pedido ficou passadas atrás', async () => {
  const entradas = [{ tipo: 'user', texto: PEDIDO_DO_WPP, timestamp: em(100) }]
  const enviados = []
  let agora = Date.parse(em(120))
  const watcher = createWatcher({
    sessions: {
      list: () => [{ name: 'infra', cwd: '/home/user', claudeSessionId: 'sid', busy: false }],
      foiPromptDoBot: (nome, texto) => texto.trim().startsWith(PEDIDO_DO_WPP),
    },
    enviar: async (nome, texto) => { enviados.push(texto) },
    ler: async ({ desde }) => entradas.filter((e) => !desde || e.timestamp > desde),
    now: () => agora,
  })
  watcher.marcar('infra', em(90))

  await watcher.passar()
  assert.deepEqual(enviados, [])

  // Minutos depois, e várias passadas adiante, o subagente responde.
  entradas.push({ tipo: 'user', texto: '<task-notification>', timestamp: em(400) })
  entradas.push({ tipo: 'assistant', texto: 'terminei', timestamp: em(405) })
  agora = Date.parse(em(440))
  await watcher.passar()

  assert.deepEqual(enviados, ['terminei'])
})

test('não encaminha nada enquanto um turno do bot está em voo', async () => {
  const { watcher, enviados } = montar({
    sessao: { busy: true },
    entradas: [
      { tipo: 'user', texto: '<task-notification>', timestamp: em(200) },
      { tipo: 'assistant', texto: 'seria duplicado', timestamp: em(210) },
    ],
  })

  watcher.marcar('infra', em(100), { doBot: true, sozinha: true })
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
    sessions: {
      list: () => [{ name: 'infra', cwd: '/home/user', claudeSessionId: 'sid', busy: false }],
      foiPromptDoBot: () => true,
    },
    enviar: async (nome, texto) => { enviados.push(texto) },
    ler: async ({ desde }) => entradas.filter((e) => !desde || e.timestamp > desde),
    now: () => agora,
  })
  watcher.marcar('infra', em(100), { doBot: true, sozinha: true })

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
      foiPromptDoBot: () => true,
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
  watcher.marcar('quebrada', em(100), { doBot: true, sozinha: true })
  watcher.marcar('boa', em(100), { doBot: true, sozinha: true })

  await watcher.passar()
  assert.deepEqual(enviados, [['boa', 'terminei']])
})

test('sem saber de quem foi o pedido, fica calado', async () => {
  // Depois de um restart nada é conhecido como nosso: o silêncio é o certo.
  const { watcher, enviados } = montar({
    nossos: [],
    entradas: [
      { tipo: 'user', texto: PEDIDO_DO_WPP, timestamp: em(100) },
      { tipo: 'user', texto: '<task-notification>', timestamp: em(200) },
      { tipo: 'assistant', texto: 'terminei', timestamp: em(210) },
    ],
  })

  watcher.marcar('infra', em(90))
  await watcher.passar()
  assert.deepEqual(enviados, [])
})
