import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClaude } from '../src/claude.js'
import { createHandler } from '../src/handler.js'
import { createSessions } from '../src/sessions.js'
import { createStore } from '../src/store.js'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'

// The butler session runs on its own model; every other session inherits the
// machine's default, which is the owner's to choose.
const BG_OUT = (id) => `backgrounded · \x1b[36m${id}\x1b[39m\n`

function claudeFalso() {
  const disparos = []
  const claude = createClaude({
    runCli: async (bin, args) => {
      if (args[0] === '--bg') { disparos.push(args); return { code: 0, stdout: BG_OUT('abc12345'), stderr: '' } }
      if (args[0] === 'agents') return { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle', state: 'done' }]), stderr: '' }
      return { code: 0, stdout: '', stderr: '' }
    },
    trust: () => {},
    readReply: async () => ({ content: 'ok', timestamp: new Date(2_000_000).toISOString() }),
    readTurnEnd: async () => null,
    sleep: async () => {},
    now: () => 2_000_000,
  })
  return { claude, disparos }
}

test('run passa --model só quando um modelo é pedido', async () => {
  const { claude, disparos } = claudeFalso()
  await claude.run({ cwd: '/tmp/x', prompt: 'oi', model: 'sonnet', timeoutMs: 1000 })
  await claude.run({ cwd: '/tmp/x', prompt: 'oi', timeoutMs: 1000 })

  assert.deepEqual(disparos[0], ['--bg', '--dangerously-skip-permissions', '--model', 'sonnet', 'oi'])
  assert.ok(!disparos[1].includes('--model'), 'sem pedido, a sessão fica no default da máquina')
})

function montarHandler() {
  const dir = mkdtempSync(join(tmpdir(), 'wpp-model-'))
  const db = openDb(':memory:')
  const pedidos = []
  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  const handler = createHandler({
    sessions,
    run: async (o) => { pedidos.push({ name: o.name, model: o.model }); return { ok: true, text: 'ok', sessionId: 'sid', error: null } },
    transcribe: async () => ({ ok: true, text: '', error: null }),
    reply: async () => {},
    config: { slowNoticeMs: 10, timeoutMs: 1000, maxMessageChars: 500, claudeBin: 'claude', defaultCwd: dir, wppModel: 'sonnet' },
    wpp: {
      outbox: createOutbox({ db, now: () => 1000 }),
      agentCwd: dir,
      tick: async () => {},
      undo: async () => ({ ok: true, job: {} }),
      botContatos: () => [],
      formalizar: async ({ texto }) => texto,
    },
  })
  return { handler, pedidos }
}

test('a sessão wpp vai com o modelo do mordomo; as outras, sem modelo', async () => {
  const { handler, pedidos } = montarHandler()
  await handler.handle('/new ~ infra')
  await handler.handle('@infra roda os testes')
  await handler.handle('/wpp olha o grupo')

  const infra = pedidos.find((p) => p.name === 'infra')
  const wpp = pedidos.find((p) => p.name === 'wpp')
  assert.equal(infra.model, null, 'infra fica no default da máquina')
  assert.equal(wpp.model, 'sonnet')
})
