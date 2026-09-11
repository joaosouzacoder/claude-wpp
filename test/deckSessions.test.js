import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/store.js'
import { createDeckSessions } from '../src/deckSessions.js'

// An agent-deck held in memory: enough to see what the registry asks of it.
function deckFalso(iniciais = []) {
  const sessoes = [...iniciais]
  const log = []
  return {
    sessoes,
    log,
    list: async () => sessoes.map((s) => ({ ...s })),
    create: async ({ cwd, name, group }) => {
      log.push(['create', name, cwd, group])
      sessoes.push({ id: `id-${name}`, title: name, status: 'waiting', group, path: cwd, parentId: null, lastActivityAt: 't' })
    },
    stop: async (name) => { log.push(['stop', name]) },
    lastReply: async () => null,
  }
}

function montar(iniciais, { dir = mkdtempSync(join(tmpdir(), 'deck-sessions-')) } = {}) {
  const deck = deckFalso(iniciais)
  const arquivo = join(dir, 'deck-state.json')
  const sessions = createDeckSessions({ deck, store: createStore(arquivo), defaultCwd: dir })
  return { deck, sessions, arquivo, dir }
}

const CONDUCTOR = { id: 'c1', title: 'conductor-dw', status: 'waiting', group: 'conductor', path: '/c/dw', parentId: null, lastActivityAt: 't1' }
const FILHO = { id: 'f1', title: 'daily-sync', status: 'running', group: 'conductor', path: '/p/dw', parentId: 'c1', lastActivityAt: 't2' }

test('lista vem do agent-deck, com filhos logo abaixo do pai', async () => {
  const { sessions } = montar([FILHO, { ...CONDUCTOR }, { id: 'x', title: 'avulsa', status: 'idle', path: '/a', parentId: null }])
  await sessions.refresh()
  assert.deepEqual(sessions.list().map((s) => s.name), ['conductor-dw', 'daily-sync', 'avulsa'])
})

test('o mesmo objeto sobrevive ao refresh, para o busy de um run em curso não sumir', async () => {
  const { sessions, deck } = montar([{ ...CONDUCTOR }])
  await sessions.refresh()
  const antes = sessions.get('conductor-dw')
  antes.busy = true
  deck.sessoes[0].status = 'running'
  await sessions.refresh()
  assert.equal(sessions.get('conductor-dw'), antes)
  assert.equal(antes.busy, true)
  assert.equal(antes.status, 'running')
})

test('sem nome, create reaproveita o home que já está no deck', async () => {
  const { sessions, deck } = montar([{ id: 'h', title: 'home', status: 'waiting', path: '/h', parentId: null }])
  await sessions.refresh()
  const s = await sessions.create({})
  assert.equal(s.name, 'home')
  assert.equal(deck.log.length, 0)
  assert.equal(sessions.active().name, 'home')
})

test('sem nome e sem home, cria o home no grupo whatsapp', async () => {
  const { sessions, deck, dir } = montar([])
  await sessions.refresh()
  const s = await sessions.create({ cwd: dir })
  assert.equal(s.name, 'home')
  assert.deepEqual(deck.log[0], ['create', 'home', dir, 'whatsapp'])
})

test('com nome explícito que já existe, recusa em vez de sequestrar a sessão', async () => {
  const { sessions } = montar([{ ...CONDUCTOR }])
  await sessions.refresh()
  await assert.rejects(sessions.create({ name: 'conductor-dw' }), /já existe/)
})

test('diretório inexistente é recusado antes de chamar o agent-deck', async () => {
  const { sessions, deck } = montar([])
  await assert.rejects(sessions.create({ cwd: '/nao/existe/mesmo', name: 'x' }), /não existe/)
  assert.equal(deck.log.length, 0)
})

test('end para a sessão no deck, não apaga', async () => {
  const { sessions, deck } = montar([{ ...CONDUCTOR }])
  await sessions.refresh()
  sessions.setActive('conductor-dw')
  assert.equal(await sessions.end('conductor-dw'), true)
  assert.deepEqual(deck.log, [['stop', 'conductor-dw']])
  assert.equal(sessions.active(), undefined)
  assert.ok(sessions.get('conductor-dw'))
})

test('sessão ativa e pedidos pendentes sobrevivem a um reinício', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-sessions-'))
  const primeiro = montar([{ ...CONDUCTOR }], { dir })
  await primeiro.sessions.refresh()
  primeiro.sessions.setActive('conductor-dw')
  primeiro.sessions.beginRun('conductor-dw', 'como estão as features?')
  primeiro.sessions.enqueue('conductor-dw', 'e o deploy?')

  const segundo = montar([{ ...CONDUCTOR }], { dir })
  await segundo.sessions.refresh()
  assert.equal(segundo.sessions.active().name, 'conductor-dw')
  const [interrompida] = segundo.sessions.interrompidas()
  assert.equal(interrompida.pending.prompt, 'como estão as features?')
  assert.deepEqual(interrompida.queue, ['e o deploy?'])
})

test('o estado do deck não encosta no state.json do modo headless', async () => {
  const { sessions, arquivo } = montar([{ ...CONDUCTOR }])
  await sessions.refresh()
  sessions.setActive('conductor-dw')
  assert.match(arquivo, /deck-state\.json$/)
  assert.equal(JSON.parse(readFileSync(arquivo, 'utf8')).activeSession, 'conductor-dw')
})

test('pedido pendente de sessão que sumiu do deck não é descartado em silêncio', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'deck-sessions-'))
  const primeiro = montar([{ ...CONDUCTOR }], { dir })
  await primeiro.sessions.refresh()
  primeiro.sessions.beginRun('conductor-dw', 'pedido')

  const segundo = montar([], { dir })
  await segundo.sessions.refresh()
  assert.equal(segundo.sessions.interrompidas().length, 1)
})

test('título fora do padrão do roteador aparece marcado, sem quebrar nada', async () => {
  const { sessions } = montar([{ id: 'z', title: 'Consult Codex', status: 'idle', path: '/z', parentId: null }])
  await sessions.refresh()
  assert.equal(sessions.list()[0].addressable, false)
})
