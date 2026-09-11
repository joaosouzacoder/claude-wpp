import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/store.js'
import { createDeckSessions } from '../src/deckSessions.js'
import { createHandler } from '../src/handler.js'

function deckFalso(sessoes) {
  const log = []
  return {
    sessoes,
    log,
    respostas: {},
    list: async () => sessoes.map((s) => ({ ...s })),
    create: async ({ cwd, name, group }) => {
      log.push(['create', name, cwd, group])
      sessoes.push({ id: `id-${name}`, title: name, status: 'waiting', group, path: cwd, parentId: null, lastActivityAt: new Date().toISOString() })
    },
    stop: async (name) => { log.push(['stop', name]) },
    async lastReply(name) { return this.respostas[name] ?? null },
  }
}

function montar(sessoes = [], { dir = mkdtempSync(join(tmpdir(), 'handler-deck-')), run } = {}) {
  const deck = deckFalso(sessoes)
  const sessions = createDeckSessions({ deck, store: createStore(join(dir, 'deck-state.json')), defaultCwd: dir })
  const ditos = []
  const enviados = []
  const handler = createHandler({
    sessions,
    run: run ?? (async (a) => { enviados.push(a); return { ok: true, text: `resposta de ${a.name}`, sessionId: null, error: null } }),
    transcribe: async () => ({ ok: true, text: '', error: null }),
    reply: async (t) => { ditos.push(t) },
    config: { slowNoticeMs: 1000, maxMessageChars: 3500, claudeBin: 'claude', defaultCwd: dir },
    wpp: { outbox: {}, agentCwd: join(dir, 'agent'), tick: async () => {}, timezone: 'UTC', undo: async () => ({}) },
  })
  return { handler, sessions, deck, ditos, enviados, dir }
}

const CONDUCTOR = { id: 'c1', title: 'conductor-dw', status: 'waiting', group: 'conductor', path: '/c/dw', parentId: null, lastActivityAt: new Date().toISOString() }
const FILHO = { id: 'f1', title: 'daily-sync', status: 'running', group: 'conductor', path: '/p/dw', parentId: 'c1', lastActivityAt: new Date().toISOString() }

test('@conductor fala com a sessão do deck pelo nome dela', async () => {
  const { handler, ditos, enviados } = montar([{ ...CONDUCTOR }])
  await handler.handle('@conductor-dw como estão as features?')
  assert.equal(enviados[0].name, 'conductor-dw')
  assert.equal(enviados[0].prompt, 'como estão as features?')
  assert.equal(ditos.at(-1), '[conductor-dw] resposta de conductor-dw')
})

test('sessão criada no deck depois do boot já é endereçável, sem reiniciar o bot', async () => {
  const sessoes = []
  const { handler, enviados } = montar(sessoes)
  sessoes.push({ ...CONDUCTOR })
  await handler.handle('@conductor-dw oi')
  assert.equal(enviados[0].name, 'conductor-dw')
})

test('mensagem sem sessão ativa vai para o home, criado no grupo whatsapp', async () => {
  const { handler, deck, enviados, dir } = montar([])
  await handler.handle('oi')
  assert.deepEqual(deck.log[0], ['create', 'home', dir, 'whatsapp'])
  assert.equal(enviados[0].name, 'home')
})

test('/ls mostra status do deck e o filho debaixo do conductor', async () => {
  const { handler, ditos } = montar([{ ...CONDUCTOR }, { ...FILHO }])
  await handler.handle('/ls')
  const linhas = ditos.at(-1).split('\n')
  assert.match(linhas[0], /conductor-dw .*\(waiting · ociosa/)
  assert.match(linhas[1], /└ daily-sync .*\(running · ociosa/)
})

test('/end para a sessão e explica que ela continua no deck', async () => {
  const { handler, deck, ditos } = montar([{ ...CONDUCTOR }])
  await handler.handle('/end conductor-dw')
  assert.deepEqual(deck.log, [['stop', 'conductor-dw']])
  assert.match(ditos.at(-1), /parada\. Ela continua no agent-deck/)
})

test('/wpp não mexe numa sessão wpp do deck que aponta para outro lugar', async () => {
  const { handler, deck, ditos, enviados } = montar([{ id: 'w', title: 'wpp', status: 'waiting', path: '/outro/lugar', parentId: null }])
  await handler.handle('/wpp responde a Ana')
  assert.equal(enviados.length, 0)
  assert.deepEqual(deck.log, [])
  assert.match(ditos.at(-1), /Não mexo nela/)
})

test('/wpp cria a sessão dedicada no diretório do agente, sem trocar a ativa', async () => {
  const { handler, sessions, deck, enviados, dir } = montar([{ ...CONDUCTOR }])
  mkdirSync(join(dir, 'agent'))
  await sessions.refresh()
  sessions.setActive('conductor-dw')
  await handler.handle('/wpp responde a Ana')
  assert.deepEqual(deck.log[0], ['create', 'wpp', join(dir, 'agent'), 'whatsapp'])
  assert.equal(enviados[0].name, 'wpp')
  assert.equal(sessions.active().name, 'conductor-dw')
})

test('depois de reiniciar, entrega a resposta que chegou enquanto o bot estava fora', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handler-deck-'))
  const antes = montar([{ ...CONDUCTOR }], { dir })
  await antes.sessions.refresh()
  antes.sessions.beginRun('conductor-dw', 'como estão as features?')

  const depois = montar([{ ...CONDUCTOR }], { dir })
  await depois.sessions.refresh()
  depois.deck.respostas['conductor-dw'] = { content: 'daily-sync terminou', timestamp: new Date(Date.now() + 1000).toISOString() }
  await depois.handler.recuperar()

  assert.match(depois.ditos[0], /\[conductor-dw\] \(chegou enquanto eu reiniciava/)
  assert.match(depois.ditos[0], /daily-sync terminou/)
  assert.equal(depois.sessions.interrompidas().length, 0)
})

test('depois de reiniciar sem resposta nova, oferece /retomar como antes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handler-deck-'))
  const antes = montar([{ ...CONDUCTOR }], { dir })
  await antes.sessions.refresh()
  antes.sessions.beginRun('conductor-dw', 'como estão as features?')

  const depois = montar([{ ...CONDUCTOR }], { dir })
  await depois.sessions.refresh()
  depois.deck.respostas['conductor-dw'] = { content: 'resposta antiga', timestamp: '2020-01-01T00:00:00.000Z' }
  await depois.handler.recuperar()

  assert.match(depois.ditos[0], /\/retomar conductor-dw/)
})

test('erro do agent-deck chega como erro, sem cair para outra sessão', async () => {
  const { handler, ditos } = montar([{ ...CONDUCTOR }], {
    run: async () => ({ ok: false, text: '', sessionId: null, error: 'não entreguei para conductor-dw: tmux fora do ar' }),
  })
  await handler.handle('@conductor-dw oi')
  assert.equal(ditos.at(-1), '[conductor-dw] Erro: não entreguei para conductor-dw: tmux fora do ar')
})

test('agent-deck que não lista no meio da conversa não derruba o handler', async () => {
  const { handler, deck, enviados } = montar([{ ...CONDUCTOR }])
  await handler.handle('@conductor-dw primeira')
  deck.list = async () => { throw new Error('tmux caiu') }
  await handler.handle('@conductor-dw segunda')
  assert.equal(enviados.length, 2)
})
