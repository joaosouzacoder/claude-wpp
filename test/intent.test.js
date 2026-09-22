import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createIntent, lerIntencao, promptIntencao, textoCitado, rascunhoNomeado, classificadorClaude, MAX_CHARS_INTENCAO } from '../src/intent.js'

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

test('classificadorClaude runs claude -p and fails on a non-zero exit or timeout', async () => {
  const chamadas = []
  const ok = classificadorClaude({
    bin: 'claude', model: 'haiku', cwd: '/tmp', timeoutMs: 1000,
    exec: async (bin, args, opts) => { chamadas.push({ bin, args, opts }); return { code: 0, stdout: '/ls\n', stderr: '' } },
  })
  assert.equal(await ok('prompt'), '/ls\n')
  assert.equal(chamadas[0].bin, 'claude')
  assert.deepEqual(chamadas[0].args.slice(0, 3), ['-p', '--model', 'haiku'])
  assert.equal(chamadas[0].args.at(-1), 'prompt')
  assert.deepEqual(chamadas[0].opts, { cwd: '/tmp', timeoutMs: 1000 })

  const falha = classificadorClaude({ bin: 'claude', model: 'haiku', cwd: '/tmp', timeoutMs: 1000, exec: async () => ({ code: 1, stdout: '', stderr: 'not logged in' }) })
  await assert.rejects(falha('prompt'), /not logged in/)
  const lento = classificadorClaude({ bin: 'claude', model: 'haiku', cwd: '/tmp', timeoutMs: 1000, exec: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }) })
  await assert.rejects(lento('prompt'), /tempo esgotado/)
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
