import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaude } from '../src/claude.js'

// `claude agents` kept a session on `busy` for 37 minutes after its turn had
// ended, and with no timeout the poll loop never left that branch. The
// transcript's own `turn_duration` entry is what settles it.
const BG_OUT = (id) => `backgrounded · \x1b[36m${id}\x1b[39m\n`
const ENVIO = 1_000_000

function montar({ agentes, readReply, readTurnEnd }) {
  let agora = ENVIO
  let polls = 0
  const claude = createClaude({
    runCli: async (bin, args) => {
      if (args[0] === '--bg') return { code: 0, stdout: BG_OUT('abc12345'), stderr: '' }
      if (args[0] === 'agents') { polls += 1; return { code: 0, stdout: JSON.stringify(agentes(polls)), stderr: '' } }
      return { code: 0, stdout: '', stderr: '' }
    },
    trust: () => {},
    readReply,
    readTurnEnd,
    sleep: async () => { agora += 500 },
    now: () => agora,
  })
  return { claude, polls: () => polls }
}

const base = { cwd: '/tmp/algum', prompt: 'oi', slowNoticeMs: 50, timeoutMs: 60_000 }
const sempreBusy = () => [{ id: 'abc12345', sessionId: 'sid-1', status: 'busy', state: 'working' }]
const depois = (ms) => new Date(ENVIO + ms).toISOString()
const antes = (ms) => new Date(ENVIO - ms).toISOString()

test('busy para sempre, mas a transcrição fechou o turno e tem resposta: entrega', async () => {
  const { claude, polls } = montar({
    agentes: sempreBusy,
    readReply: async () => ({ content: 'Passei para a sessão infra.', timestamp: depois(5_000) }),
    readTurnEnd: async () => ({ timestamp: depois(9_000) }),
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'Passei para a sessão infra.')
  assert.ok(polls() <= 2, `não ficou sondando: ${polls()} olhadas`)
})

test('busy com resposta parcial e turno ainda aberto: continua esperando', async () => {
  // O caso de um pai esperando subagent: já falou algo, mas não fechou o turno.
  let terminou = false
  const { claude } = montar({
    agentes: (n) => {
      if (n < 4) return sempreBusy()
      terminou = true
      return [{ id: 'abc12345', sessionId: 'sid-1', status: 'idle', state: 'done' }]
    },
    readReply: async () => (terminou
      ? { content: 'Resultado final: 36 bytes cada.', timestamp: depois(20_000) }
      : { content: 'Vou pedir ao swat.', timestamp: depois(5_000) }),
    readTurnEnd: async () => null,
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'Resultado final: 36 bytes cada.', 'esperou o turno acabar de verdade')
})

test('fim de turno anterior ao envio não conta', async () => {
  let terminou = false
  const { claude } = montar({
    agentes: (n) => {
      if (n < 3) return sempreBusy()
      terminou = true
      return [{ id: 'abc12345', sessionId: 'sid-1', status: 'idle', state: 'done' }]
    },
    readReply: async () => (terminou
      ? { content: 'resposta de agora', timestamp: depois(8_000) }
      : { content: 'resposta de ontem', timestamp: antes(60_000) }),
    readTurnEnd: async () => ({ timestamp: antes(50_000) }),
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'resposta de agora')
})
