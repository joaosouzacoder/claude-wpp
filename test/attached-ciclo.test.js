import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAttachedRunner } from '../src/attached.js'

// Inside his own session the same rules hold, with one difference: nothing
// here ever stops the session — the bot only stops waiting.
const INICIO = 1_000_000
const em = (ms) => new Date(INICIO + ms).toISOString()

function tmuxFalso() {
  const chamadas = []
  return {
    chamadas,
    tmux: {
      disponivel: async () => true,
      viva: async () => true,
      abrir: async () => ({ ok: true, stderr: '' }),
      digitar: async (n, texto) => { chamadas.push(['digitar', texto]); return { ok: true, stderr: '' } },
      matar: async (n) => { chamadas.push(['matar', n]); return { ok: true } },
    },
  }
}

function montar({ readReply, readTurnEnd, readActivity, passo = 1_000 }) {
  const { tmux, chamadas } = tmuxFalso()
  let agora = INICIO
  const runAttached = createAttachedRunner({
    tmux,
    readReply,
    readTurnEnd: readTurnEnd ?? (async () => null),
    readActivity: readActivity ?? (async () => null),
    descobrir: async () => null,
    sleep: async () => { agora += passo },
    now: () => agora,
  })
  return { runAttached, chamadas }
}

const base = { nome: 'infra', cwd: '/tmp', agentId: 'ab12cd34', sessionId: 'sid-dele', prompt: 'roda os testes', slowNoticeMs: 50 }

// The runner reads the last reply once before typing, to know what is old.
const depoisDeDigitar = (nova, antiga = { content: 'de antes', timestamp: em(-60_000) }) => {
  let chamadas = 0
  return async () => (chamadas++ === 0 ? antiga : nova)
}

test('o turno fechou na transcrição: entrega sem esperar o texto sossegar', async () => {
  const c = montar({
    readReply: depoisDeDigitar({ content: 'Rodei. 42 passando.', timestamp: em(3_000) }),
    readTurnEnd: async () => ({ timestamp: em(3_500) }),
  })
  const r = await c.runAttached({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'Rodei. 42 passando.')
})

test('nada escrito depois da mensagem por mais que o teto: desiste, aponta a janela, não mata', async () => {
  const c = montar({
    readReply: async () => ({ content: 'de antes', timestamp: em(-60_000) }),
    readActivity: async () => ({ lastAssistantAt: em(-60_000), modifiedAt: INICIO - 60_000 }),
  })
  const r = await c.runAttached({ ...base, semSaidaMs: 5_000 })
  assert.equal(r.ok, false)
  assert.equal(r.podeCair, false, 'a mensagem já foi digitada: não vai pela outra via')
  assert.match(r.error, /não escreveu nada em 0min/)
  assert.match(r.error, /tmux attach -t wpp-infra/)
  assert.ok(!c.chamadas.some((x) => x[0] === 'matar'))
})

test('escreveu e silenciou com o turno aberto: libera, com o que já disse', async () => {
  const c = montar({
    readReply: depoisDeDigitar({ content: 'Vou pedir ao swat.', timestamp: em(2_000) }),
    readActivity: async () => ({ lastAssistantAt: em(2_000), modifiedAt: INICIO + 2_000 }),
  })
  const r = await c.runAttached({ ...base, silencioMs: 5_000 })
  assert.equal(r.ok, true)
  assert.equal(r.tarde, true)
  assert.equal(r.desde, em(2_000))
  assert.match(r.text, /Parei de esperar/)
  assert.match(r.text, /Vou pedir ao swat\./)
  assert.ok(!c.chamadas.some((x) => x[0] === 'matar'))
})

test('texto parcial recém-escrito não é entregue como final enquanto a sessão segue escrevendo', async () => {
  let agora = INICIO
  let vezes = 0
  const c = montar({
    readReply: async () => ({ content: vezes > 8 ? 'resultado final' : 'parcial', timestamp: em(vezes > 8 ? 9_000 : 1_000) }),
    readTurnEnd: async () => (vezes > 8 ? { timestamp: em(9_500) } : null),
    readActivity: async () => { vezes += 1; agora += 1_000; return { lastAssistantAt: em(1_000), modifiedAt: agora } },
  })
  const r = await c.runAttached({ ...base, semSaidaMs: 60_000, silencioMs: 60_000 })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'resultado final')
})
