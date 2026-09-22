import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIntent, lerIntencao, promptIntencao, textoCitado, rascunhoNomeado, classificadorOpenAI, MAX_CHARS_INTENCAO } from '../src/intent.js'

const conhecidos = new Set(['ok', 'bot', 'no', 'wpp', 'ls'])

test('lerIntencao accepts only a known command', () => {
  assert.equal(lerIntencao('/bot 31\n', conhecidos), '/bot 31')
  assert.equal(lerIntencao('`/no 4`', conhecidos), '/no 4')
  assert.equal(lerIntencao('NENHUM', conhecidos), null)
  assert.equal(lerIntencao('/rm -rf', conhecidos), null)
  assert.equal(lerIntencao('Claro! /ok 3', conhecidos), null)
  assert.equal(lerIntencao('', conhecidos), null)
})

test('promptIntencao lists pending drafts and the quoted message', () => {
  const p = promptIntencao({
    texto: 'manda esse pelo bot',
    ajuda: '/bot <n>',
    citada: 'Rascunho #7 para Luan',
    pendentes: [{ id: 7, chat_name: 'Luan', body: 'chego 10h' }],
  })
  assert.match(p, /#7 para Luan: "chego 10h"/)
  assert.match(p, /citando esta mensagem do bot:\n"Rascunho #7 para Luan"/)
  assert.match(p, /manda esse pelo bot$/)
})

test('textoCitado reads the quoted text', () => {
  const raw = { message: { extendedTextMessage: { text: 'ok', contextInfo: { quotedMessage: { conversation: 'Rascunho #2' } } } } }
  assert.equal(textoCitado(raw), 'Rascunho #2')
  assert.equal(textoCitado(null), null)
})

test('a draft command runs only on a draft he pointed at', () => {
  const dois = [{ id: 28 }, { id: 31 }]
  assert.equal(rascunhoNomeado('/no 31', { texto: 'joga fora o rascunho', pendentes: dois }), false)
  assert.equal(rascunhoNomeado('/no 31', { texto: 'joga fora o 31', pendentes: dois }), true)
  assert.equal(rascunhoNomeado('/no 3', { texto: 'joga fora o 31', pendentes: dois }), false)
  assert.equal(rascunhoNomeado('/bot 28', { texto: 'manda pelo bot', citada: 'Rascunho #28 para Luan', pendentes: dois }), true)
  assert.equal(rascunhoNomeado('/ok 31', { texto: 'manda', pendentes: [{ id: 31 }] }), true)
  assert.equal(rascunhoNomeado('/ok', { texto: 'manda', pendentes: [{ id: 31 }] }), false)
  assert.equal(rascunhoNomeado('/wpp avisa o Luan', { texto: 'avisa o Luan', pendentes: dois }), true)
})

test('createIntent drops a guessed draft number', async () => {
  const interpretar = createIntent({ classify: async () => '/no 31', ajuda: '', conhecidos })
  assert.equal(await interpretar({ texto: 'joga fora o rascunho', pendentes: [{ id: 28 }, { id: 31 }] }), null)
})

test('classificadorOpenAI returns the reply text and fails on an error status', async () => {
  const pedidos = []
  const ok = classificadorOpenAI({
    apiKey: 'sk-teste', model: 'm', timeoutMs: 1000,
    fetchImpl: async (url, init) => { pedidos.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: '/ls' } }] }) } },
  })
  assert.equal(await ok('prompt'), '/ls')
  assert.equal(pedidos[0].messages[0].content, 'prompt')

  const erro = classificadorOpenAI({ apiKey: 'sk-teste', model: 'm', timeoutMs: 1000, fetchImpl: async () => ({ ok: false, status: 429 }) })
  await assert.rejects(erro('prompt'), /429/)
})

test('a failed or skipped classification is "not a command"', async () => {
  let chamadas = 0
  const falha = createIntent({ classify: async () => { chamadas++; throw new Error('fora') }, ajuda: '', conhecidos })
  assert.equal(await falha({ texto: 'aprova o 3', pendentes: [] }), null)

  const nunca = createIntent({ classify: async () => { chamadas++; return '/ok 1' }, ajuda: '', conhecidos })
  assert.equal(await nunca({ texto: 'x'.repeat(MAX_CHARS_INTENCAO + 1), pendentes: [] }), null)
  assert.equal(await nunca({ texto: '   ', pendentes: [] }), null)
  assert.equal(chamadas, 1)
})
