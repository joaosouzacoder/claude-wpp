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

// The two ways the bot used to end up answering *beside* his session instead
// of inside it: a stored agent id that went stale, and a session he started in
// his own terminal, which `claude agents` never lists.
function montar({ listAgents, runAttached, run } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'handler-dentro-'))
  const db = openDb(':memory:')
  const ditos = []
  const foraDela = []
  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  const handler = createHandler({
    sessions,
    listAgents,
    runAttached,
    run: run ?? (async (o) => { foraDela.push(o); return { ok: true, text: 'por fora', sessionId: 'bifurcada', error: null } }),
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
  return { handler, sessions, ditos, foraDela, dir }
}

const noHost = (nome, id, extra = {}) => ({ name: nome, sessionId: id, id: `ag-${id}`, cwd: tmpdir(), kind: 'background', status: 'idle', ...extra })

test('o id do agente é procurado na hora, e não lido de um registro velho', async () => {
  const dentro = []
  const { handler, sessions } = montar({
    listAgents: async () => [noHost('infra', 'DELE-1')],
    runAttached: async (o) => { dentro.push(o); return { ok: true, text: 'dentro', sessionId: o.sessionId, error: null } },
  })

  await handler.handle('@infra primeira')
  // O registro perde o id do agente — foi exatamente o que aconteceu em
  // produção depois de um deploy, e derrubava o turno para a via que bifurca.
  sessions.get('infra').agenteId = null

  await handler.handle('@infra segunda')

  assert.equal(dentro.length, 2, 'o segundo turno também foi por dentro')
  assert.equal(dentro[1].agentId, 'ag-DELE-1', 'com o id achado na listagem, não o do registro')
})

test('sessão que ele abriu no terminal (sem agente listado) também é respondida por dentro', async () => {
  const dentro = []
  const { handler, sessions, ditos, foraDela } = montar({
    // A sessão está na listagem só quando ele a adota; depois some da lista,
    // como acontece com uma sessão iniciada no terminal dele.
    listAgents: (() => { let vez = 0; return async () => (vez++ === 0 ? [noHost('infra', 'DELE-1')] : []) })(),
    runAttached: async (o) => {
      dentro.push(o)
      return { ok: true, text: 'dentro', sessionId: 'CONTINUOU-AQUI', janela: 'wpp-infra', abriu: true, error: null }
    },
  })

  await handler.handle('@infra roda os testes')

  assert.equal(dentro.length, 1, 'foi por dentro mesmo sem agente na lista')
  assert.equal(dentro[0].agentId, null, 'sem id: a janela abre a conversa dela mesma')
  assert.deepEqual(foraDela, [], 'e nada foi disparado por fora')
  assert.equal(sessions.get('infra').claudeSessionId, 'CONTINUOU-AQUI', 'passa a seguir onde a conversa continuou')
  assert.ok(ditos.some((d) => /tmux attach -t wpp-infra/.test(d)), 'e diz onde entrar pelo terminal')
})

test('o aviso da janela sai uma vez, não a cada mensagem', async () => {
  const { handler, ditos } = montar({
    listAgents: async () => [noHost('infra', 'DELE-1')],
    runAttached: (() => {
      let primeira = true
      return async (o) => {
        const abriu = primeira
        primeira = false
        return { ok: true, text: 'dentro', sessionId: o.sessionId, janela: 'wpp-infra', abriu, error: null }
      }
    })(),
  })

  await handler.handle('@infra uma')
  await handler.handle('@infra duas')

  assert.equal(ditos.filter((d) => /tmux attach/.test(d)).length, 1)
})
