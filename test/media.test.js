import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { saveMedia, promptComImagem } from '../src/media.js'

function pastaTemp() {
  return mkdtempSync(join(tmpdir(), 'media-'))
}

test('saveMedia grava o buffer e devolve o caminho do arquivo', () => {
  const dir = pastaTemp()
  const buffer = Buffer.from('conteudo-binario')

  const caminho = saveMedia({ dir, buffer, mimetype: 'image/jpeg', kind: 'image' })

  assert.equal(dirname(caminho), dir)
  assert.deepEqual(readFileSync(caminho), buffer)
})

test('saveMedia cria a pasta se ela ainda não existe', () => {
  const dir = join(pastaTemp(), 'ainda', 'nao', 'existe')

  const caminho = saveMedia({ dir, buffer: Buffer.from('x'), mimetype: 'image/png', kind: 'image' })

  assert.ok(existsSync(caminho))
})

test('saveMedia deriva a extensão do mimetype', () => {
  const dir = pastaTemp()
  const buffer = Buffer.from('x')

  assert.equal(extname(saveMedia({ dir, buffer, mimetype: 'image/png', kind: 'image' })), '.png')
  assert.equal(extname(saveMedia({ dir, buffer, mimetype: 'image/webp', kind: 'image' })), '.webp')
  assert.equal(extname(saveMedia({ dir, buffer, mimetype: 'audio/mpeg', kind: 'audio' })), '.mp3')
})

test('saveMedia ignora os parâmetros do mimetype do WhatsApp', () => {
  const dir = pastaTemp()

  const caminho = saveMedia({ dir, buffer: Buffer.from('x'), mimetype: 'audio/ogg; codecs=opus', kind: 'audio' })

  assert.equal(extname(caminho), '.ogg')
})

test('saveMedia cai num default por tipo quando o mimetype é desconhecido', () => {
  const dir = pastaTemp()
  const buffer = Buffer.from('x')

  assert.equal(extname(saveMedia({ dir, buffer, mimetype: 'image/exotico', kind: 'image' })), '.jpg')
  assert.equal(extname(saveMedia({ dir, buffer, mimetype: undefined, kind: 'audio' })), '.ogg')
})

test('saveMedia não sobrescreve arquivo anterior do mesmo tipo', () => {
  const dir = pastaTemp()

  const primeiro = saveMedia({ dir, buffer: Buffer.from('um'), mimetype: 'image/jpeg', kind: 'image' })
  const segundo = saveMedia({ dir, buffer: Buffer.from('dois'), mimetype: 'image/jpeg', kind: 'image' })

  assert.notEqual(primeiro, segundo)
  assert.equal(readFileSync(primeiro, 'utf8'), 'um')
  assert.equal(readFileSync(segundo, 'utf8'), 'dois')
})

test('promptComImagem anexa o caminho abaixo da legenda', () => {
  const prompt = promptComImagem('o que tem de errado aqui?', '/tmp/media/foto.jpg')

  assert.match(prompt, /^o que tem de errado aqui\?/)
  assert.match(prompt, /\/tmp\/media\/foto\.jpg/)
})

test('promptComImagem usa um pedido padrão quando não há legenda', () => {
  const semLegenda = promptComImagem('', '/tmp/media/foto.jpg')
  const soEspaco = promptComImagem('   ', '/tmp/media/foto.jpg')

  assert.match(semLegenda, /^Analise a imagem anexada\./)
  assert.equal(soEspaco, semLegenda)
})
