import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '../src/router.js'

test('texto solto vai para a sessão ativa', () => {
  assert.deepEqual(parse('roda os testes'), { type: 'message', target: null, text: 'roda os testes' })
})

test('apara espaços em volta', () => {
  assert.deepEqual(parse('  oi  '), { type: 'message', target: null, text: 'oi' })
})

test('comando sem argumento', () => {
  assert.deepEqual(parse('/ls'), { type: 'command', name: 'ls', args: [] })
})

test('comando com argumentos', () => {
  assert.deepEqual(parse('/new ~/work/api api'), {
    type: 'command', name: 'new', args: ['~/work/api', 'api'],
  })
})

test('comando é case-insensitive', () => {
  assert.deepEqual(parse('/LS'), { type: 'command', name: 'ls', args: [] })
})

test('@nome roteia sem trocar a ativa', () => {
  assert.deepEqual(parse('@infra checa o disco'), {
    type: 'message', target: 'infra', text: 'checa o disco',
  })
})

test('@nome preserva múltiplas linhas do texto', () => {
  assert.deepEqual(parse('@api arruma\nisso aqui'), {
    type: 'message', target: 'api', text: 'arruma\nisso aqui',
  })
})

test('@nome sozinho é erro explícito', () => {
  const r = parse('@api')
  assert.equal(r.type, 'error')
  assert.match(r.message, /@nome/)
})

test('e-mail no meio do texto não vira roteamento', () => {
  assert.deepEqual(parse('manda pro fulano@example.com'), {
    type: 'message', target: null, text: 'manda pro fulano@example.com',
  })
})

test('barra sozinha é erro, não comando', () => {
  assert.equal(parse('/').type, 'error')
})
