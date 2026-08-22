import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/store.js'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'store-')), 'sub', 'state.json')

test('devolve o estado vazio quando o arquivo não existe', () => {
  const store = createStore(fresh())
  assert.deepEqual(store.load(), { sessions: [], activeSession: null })
})

test('devolve o estado vazio quando o arquivo está corrompido', () => {
  const path = fresh()
  const store = createStore(path)
  store.save({ sessions: [], activeSession: null })
  writeFileSync(path, '{ isso não é json')
  assert.deepEqual(store.load(), { sessions: [], activeSession: null })
})

test('grava e relê o estado, criando o diretório', () => {
  const path = fresh()
  const store = createStore(path)
  const state = { sessions: [{ name: 'api', cwd: '/tmp', claudeSessionId: 'x' }], activeSession: 'api' }
  store.save(state)
  assert.ok(existsSync(path))
  assert.deepEqual(store.load(), state)
})

test('não deixa arquivo temporário para trás', () => {
  const path = fresh()
  const store = createStore(path)
  store.save({ sessions: [], activeSession: null })
  const sobras = readdirSync(join(path, '..')).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(sobras, [])
})
