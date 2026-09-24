import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/store.js'
import { createSessions } from '../src/sessions.js'

// Reading a conversation back gives no hint of who typed what. This is how a
// request that came over WhatsApp is told apart from one he typed himself.
const novo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sess-origem-'))
  const store = createStore(join(dir, 'state.json'))
  return { store, dir, sessions: createSessions({ store, defaultCwd: dir }) }
}

test('um pedido que o bot digitou é reconhecido depois; o dele, não', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'infra' })
  sessions.registrarPromptDoBot('infra', 'peça pro conta-antiga listar as ec2')

  assert.equal(sessions.foiPromptDoBot('infra', 'peça pro conta-antiga listar as ec2'), true)
  assert.equal(sessions.foiPromptDoBot('infra', 'liste os usuários do IAM'), false)
  assert.equal(sessions.foiPromptDoBot('infra', '   '), false)
  assert.equal(sessions.foiPromptDoBot('fantasma', 'qualquer coisa'), false)
})

test('um pedido longo é reconhecido pelo começo', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'infra' })
  const longo = `${'analise o relatório inteiro '.repeat(20)}e me diga o resumo`
  sessions.registrarPromptDoBot('infra', longo)

  assert.equal(sessions.foiPromptDoBot('infra', `${longo}\n`), true)
})

test('guarda só os últimos pedidos, sem crescer sem limite', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'infra' })
  for (let i = 0; i < 30; i += 1) sessions.registrarPromptDoBot('infra', `pedido ${i}`)

  assert.equal(sessions.get('infra').promptsDoBot.length, 10)
  assert.equal(sessions.foiPromptDoBot('infra', 'pedido 29'), true)
  assert.equal(sessions.foiPromptDoBot('infra', 'pedido 0'), false)
})

test('os pedidos do bot não sobrevivem ao restart', () => {
  const { sessions, store, dir } = novo()
  sessions.create({ cwd: dir, name: 'infra' })
  sessions.registrarPromptDoBot('infra', 'um pedido nosso')

  // Sem saber o que é nosso, o certo é ficar calado — nunca supor que é.
  const depois = createSessions({ store, defaultCwd: dir })
  assert.equal(depois.foiPromptDoBot('infra', 'um pedido nosso'), false)
})
