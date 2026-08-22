import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createStore } from '../src/store.js'
import { createSessions } from '../src/sessions.js'

const novo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sess-'))
  const store = createStore(join(dir, 'state.json'))
  return { store, dir, sessions: createSessions({ store, defaultCwd: dir }) }
}

test('a primeira sessão criada vira a ativa', () => {
  const { sessions, dir } = novo()
  const s = sessions.create({ cwd: dir, name: 'api' })
  assert.equal(s.name, 'api')
  assert.equal(s.cwd, dir)
  assert.equal(s.claudeSessionId, null)
  assert.equal(s.busy, false)
  assert.equal(sessions.active().name, 'api')
})

test('gera nome automático quando não informado', () => {
  const { sessions, dir } = novo()
  assert.equal(sessions.create({ cwd: dir }).name, 's1')
  assert.equal(sessions.create({ cwd: dir }).name, 's2')
})

test('nome automático não colide com nome manual', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 's1' })
  assert.equal(sessions.create({ cwd: dir }).name, 's2')
})

test('usa o defaultCwd quando não informado', () => {
  const { sessions, dir } = novo()
  assert.equal(sessions.create({}).cwd, dir)
})

test('expande o til no cwd', () => {
  const { sessions } = novo()
  assert.equal(sessions.create({ cwd: '~' }).cwd, homedir())
})

test('recusa nome duplicado', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'api' })
  assert.throws(() => sessions.create({ cwd: dir, name: 'api' }), /já existe/)
})

test('recusa nome inválido', () => {
  const { sessions, dir } = novo()
  assert.throws(() => sessions.create({ cwd: dir, name: 'com espaço' }), /nome inválido/i)
})

test('recusa cwd inexistente', () => {
  const { sessions } = novo()
  assert.throws(() => sessions.create({ cwd: '/nao/existe/mesmo' }), /não existe/)
})

test('setActive troca a ativa e recusa nome desconhecido', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'a' })
  sessions.create({ cwd: dir, name: 'b' })
  assert.equal(sessions.active().name, 'b')
  assert.equal(sessions.setActive('a'), true)
  assert.equal(sessions.active().name, 'a')
  assert.equal(sessions.setActive('zzz'), false)
  assert.equal(sessions.active().name, 'a')
})

test('encerrar a ativa promove outra sessão', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'a' })
  sessions.create({ cwd: dir, name: 'b' })
  assert.equal(sessions.end('b'), true)
  assert.equal(sessions.active().name, 'a')
})

test('encerrar a última sessão deixa a ativa nula', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'a' })
  sessions.end('a')
  assert.equal(sessions.active(), undefined)
  assert.deepEqual(sessions.list(), [])
})

test('estado sobrevive a um restart, sem campos de runtime', () => {
  const { store, sessions, dir } = novo()
  const s = sessions.create({ cwd: dir, name: 'api' })
  s.claudeSessionId = 'uuid-123'
  s.busy = true
  s.queue.push('nao devia persistir')
  sessions.touch('api')

  const bruto = store.load()
  assert.equal(bruto.sessions[0].claudeSessionId, 'uuid-123')
  assert.equal(bruto.sessions[0].busy, undefined)
  assert.equal(bruto.sessions[0].queue, undefined)

  const revividas = createSessions({ store, defaultCwd: dir })
  const r = revividas.get('api')
  assert.equal(r.claudeSessionId, 'uuid-123')
  assert.equal(r.busy, false)
  assert.deepEqual(r.queue, [])
  assert.equal(revividas.active().name, 'api')
})
