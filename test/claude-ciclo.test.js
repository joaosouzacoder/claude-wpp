import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaude } from '../src/claude.js'

// A turn never waits forever. The transcript decides when it is over, and two
// ceilings decide when the bot stops waiting on one that is not producing.
const BG_OUT = (id) => `backgrounded · \x1b[36m${id}\x1b[39m\n`
const ENVIO = 1_000_000
const em = (ms) => new Date(ENVIO + ms).toISOString()

function montar({ agentes, readReply, readTurnEnd, readActivity, passo = 500 }) {
  let agora = ENVIO
  const chamadas = []
  const claude = createClaude({
    runCli: async (bin, args) => {
      chamadas.push(args)
      if (args[0] === '--bg') return { code: 0, stdout: BG_OUT('abc12345'), stderr: '' }
      if (args[0] === 'agents') return { code: 0, stdout: JSON.stringify(agentes(agora)), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    trust: () => {},
    readReply,
    readTurnEnd,
    readActivity: readActivity ?? (async () => null),
    sleep: async () => { agora += passo },
    now: () => agora,
  })
  return { claude, chamadas, cli: (nome) => chamadas.filter((a) => a[0] === nome).length }
}

const ocupado = () => [{ id: 'abc12345', sessionId: 'sid-1', kind: 'background', state: 'working' }]
const base = { cwd: '/tmp/algum', prompt: 'oi', slowNoticeMs: 50, timeoutMs: null }

test('a transcrição fechou o turno: entrega na hora, mesmo com a listagem dizendo working', async () => {
  const c = montar({
    agentes: ocupado,
    readReply: async () => ({ content: 'Passei para a infra.', timestamp: em(1_500) }),
    readTurnEnd: async () => ({ timestamp: em(2_000) }),
    readActivity: async () => ({ lastAssistantAt: em(1_500), modifiedAt: ENVIO + 2_000 }),
  })
  const r = await c.claude.run({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'Passei para a infra.')
  assert.ok(c.cli('agents') <= 1, 'não ficou sondando a listagem')
  assert.equal(c.cli('stop'), 1, 'o agente do turno encerrado é parado como sempre')
})

test('turno fechado sem texto é dito como tal, não esperado para sempre', async () => {
  const c = montar({
    agentes: ocupado,
    readReply: async () => ({ content: 'de ontem', timestamp: em(-60_000) }),
    readTurnEnd: async () => ({ timestamp: em(2_000) }),
  })
  const r = await c.claude.run({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /terminou sem responder em texto/)
})

test('nada escrito depois do pedido por mais que o teto: cancela e para o agente', async () => {
  const c = montar({
    agentes: ocupado,
    readReply: async () => null,
    readTurnEnd: async () => null,
    readActivity: async () => ({ lastAssistantAt: em(-120_000), modifiedAt: ENVIO - 120_000 }),
    passo: 1_000,
  })
  const r = await c.claude.run({ ...base, semSaidaMs: 5_000 })
  assert.equal(r.ok, false)
  assert.match(r.error, /não produziu nada em 0min — cancelei/)
  assert.ok(c.cli('stop') >= 1, 'o agente travado é parado')
  assert.equal(c.cli('rm'), 1, 'e a entrada dele é removida, como num turno normal')
})

test('escreveu e depois silenciou com o turno aberto: libera sem matar a sessão', async () => {
  const c = montar({
    agentes: ocupado,
    readReply: async () => ({ content: 'Vou pedir ao swat.', timestamp: em(1_000) }),
    readTurnEnd: async () => null,
    readActivity: async () => ({ lastAssistantAt: em(1_000), modifiedAt: ENVIO + 1_000 }),
    passo: 1_000,
  })
  const r = await c.claude.run({ ...base, silencioMs: 5_000 })
  assert.equal(r.ok, true)
  assert.equal(r.tarde, true)
  assert.equal(r.desde, em(1_000), 'o que vier depois disso é a resposta tardia')
  assert.match(r.text, /Parei de esperar/)
  assert.match(r.text, /Vou pedir ao swat\./, 'o que ela já disse vai junto')
  assert.equal(c.cli('stop'), 0, 'a sessão continua trabalhando')
  assert.equal(c.cli('rm'), 0)
})

test('um turno que segue escrevendo não é cortado, e termina quando a transcrição fecha', async () => {
  let agora = ENVIO
  let olhadas = 0
  const c = montar({
    agentes: ocupado,
    readReply: async () => ({ content: olhadas > 6 ? 'resultado final' : 'parcial', timestamp: em(olhadas > 6 ? 8_000 : 500) }),
    readTurnEnd: async () => (olhadas > 6 ? { timestamp: em(8_500) } : null),
    readActivity: async () => { olhadas += 1; agora += 1_000; return { lastAssistantAt: em(500), modifiedAt: agora } },
    passo: 1_000,
  })
  const r = await c.claude.run({ ...base, semSaidaMs: 5_000, silencioMs: 5_000 })
  assert.equal(r.ok, true)
  assert.equal(r.tarde, undefined)
  assert.equal(r.text, 'resultado final')
})

test('a pré-checagem de sessão ocupada entende a listagem sem status', async () => {
  const c = montar({
    agentes: () => [{ id: 'outro', sessionId: 'sid-x', kind: 'background', state: 'working' }],
    readReply: async () => null,
    readTurnEnd: async () => null,
  })
  const r = await c.claude.run({ ...base, sessionId: 'sid-x' })
  assert.equal(r.ok, false)
  assert.match(r.error, /ocupada agora/)
  assert.equal(c.cli('--bg'), 0, 'não dispara em cima de um turno em andamento')
})
