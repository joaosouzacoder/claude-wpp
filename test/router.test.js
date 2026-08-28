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
  assert.deepEqual(parse('/ls'), { type: 'command', name: 'ls', args: [], rest: '' })
})

test('comando com argumentos', () => {
  assert.deepEqual(parse('/new ~/work/api api'), {
    type: 'command', name: 'new', args: ['~/work/api', 'api'], rest: '~/work/api api',
  })
})

test('comando é case-insensitive', () => {
  assert.deepEqual(parse('/LS'), { type: 'command', name: 'ls', args: [], rest: '' })
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

// O texto de uma mensagem não sobrevive a split(/\s+/): quebras de linha e
// espaços duplos somem. Comandos que carregam texto de verdade usam `rest`.
test('comando carrega o texto cru depois do nome', () => {
  assert.equal(parse('/edit 4 Passando  para lembrar').rest, '4 Passando  para lembrar')
})

test('rest preserva quebra de linha', () => {
  assert.equal(parse('/edit 4 primeira linha\nsegunda linha').rest, '4 primeira linha\nsegunda linha')
})

test('comando sem argumento tem rest vazio', () => {
  assert.equal(parse('/ls').rest, '')
})

// A rota HTTP monta `/wpp <pedido>` e entrega ao mesmo handler. Se um pedido
// que começa com barra virasse um segundo comando, quem chama a API pela rede
// alcançaria /ok — e aprovaria o próprio rascunho sem passar pelo dono.
test('o que vem depois de /wpp é texto, nunca um segundo comando', () => {
  assert.deepEqual(parse('/wpp /ok 5'), {
    type: 'command', name: 'wpp', args: ['/ok', '5'], rest: '/ok 5',
  })
})
