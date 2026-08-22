import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText } from '../src/text.js'

test('texto curto vira um pedaço só', () => {
  assert.deepEqual(chunkText('oi', 100), ['oi'])
})

test('texto vazio ainda devolve um pedaço', () => {
  assert.deepEqual(chunkText('', 100), [''])
})

test('quebra preferindo a quebra de linha', () => {
  const texto = 'aaaa\nbbbb\ncccc'
  const partes = chunkText(texto, 10)
  assert.ok(partes.length > 1)
  assert.ok(partes.every((p) => p.length <= 10))
  assert.equal(partes.join('\n'), texto)
})

test('quebra à força quando uma linha é maior que o limite', () => {
  const partes = chunkText('x'.repeat(25), 10)
  assert.deepEqual(partes, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
})

test('nenhum pedaço ultrapassa o limite', () => {
  const texto = Array.from({ length: 50 }, (_, i) => `linha ${i} com algum conteúdo`).join('\n')
  for (const parte of chunkText(texto, 120)) assert.ok(parte.length <= 120)
})
