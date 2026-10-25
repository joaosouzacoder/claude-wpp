import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHandler } from '../src/handler.js'
import { createSessions } from '../src/sessions.js'
import { createStore } from '../src/store.js'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'

// When a run gives up waiting on a turn still open, the handler delivers the
// notice and leaves the session marked so the watcher forwards what comes.
function montar(resultado) {
  const dir = mkdtempSync(join(tmpdir(), 'handler-tardia-'))
  const db = openDb(':memory:')
  const ditos = []
  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  const handler = createHandler({
    sessions,
    run: async () => resultado,
    transcribe: async () => ({ ok: true, text: '', error: null }),
    reply: async (t) => { ditos.push(t) },
    config: { slowNoticeMs: 10, timeoutMs: 1000, maxMessageChars: 500, claudeBin: 'claude', defaultCwd: dir },
    wpp: {
      outbox: createOutbox({ db, now: () => 1000 }),
      agentCwd: dir,
      tick: async () => {},
      undo: async () => ({ ok: true, job: {} }),
      botContatos: () => [],
      formalizar: async ({ texto }) => texto,
    },
  })
  return { handler, sessions, ditos }
}

test('turno liberado: o aviso chega e a sessão fica marcada para entrega tardia', async () => {
  const { handler, sessions, ditos } = montar({
    ok: true,
    tarde: true,
    desde: '2026-10-25T10:01:00.000Z',
    sessionId: 'sid-1',
    text: 'infra está há 30min sem escrever nada e o turno não fechou. Parei de esperar; se ela responder, te encaminho.',
    error: null,
  })
  await handler.handle('/new ~ infra')
  await handler.handle('@infra roda os testes')

  assert.ok(ditos.some((d) => /Parei de esperar/.test(d)), ditos.join(' | '))
  assert.equal(sessions.get('infra').entregaTardia, '2026-10-25T10:01:00.000Z')
  assert.equal(sessions.get('infra').busy, false, 'a sessão volta a aceitar pedidos')
  assert.equal(sessions.get('infra').pending, null)
})

test('turno normal não deixa marca', async () => {
  const { handler, sessions } = montar({ ok: true, text: 'pronto', sessionId: 'sid-1', error: null })
  await handler.handle('/new ~ infra')
  await handler.handle('@infra oi')
  assert.equal(sessions.get('infra').entregaTardia, null)
})
