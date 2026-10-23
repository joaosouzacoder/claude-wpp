import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, utimesSync } from 'node:fs'
import { join, dirname, extname } from 'node:path'
import { tmpdir } from 'node:os'
import { saveMedia, promptComImagem, limparMediaAntiga, podarMidia, extrairArquivos } from '../src/media.js'
import { homedir } from 'node:os'

test('documento é salvo com o nome original, sem virar caminho', () => {
  const dir = mkdtempSync(join(tmpdir(), 'media-'))
  const caminho = saveMedia({ dir, buffer: Buffer.from('x'), mimetype: 'application/pdf', kind: 'document', fileName: '../../etc/contrato final.pdf' })
  assert.equal(dirname(caminho), dir, 'fica dentro da pasta de mídia')
  assert.ok(caminho.endsWith('-_.._etc_contrato final.pdf'), caminho)
  assert.equal(extname(caminho), '.pdf')
  assert.equal(readFileSync(caminho, 'utf8'), 'x')
})

test('extrairArquivos tira as marcas, resolve relativo e ~, e não repete', () => {
  const { texto, arquivos } = extrairArquivos('Pronto.\n[[arquivo: out/a.csv]]\n  [[arquivo: ~/b.pdf]]\n[[arquivo: out/a.csv]]\nFim.', '/srv/proj')
  assert.equal(texto, 'Pronto.\nFim.')
  assert.deepEqual(arquivos, ['/srv/proj/out/a.csv', join(homedir(), 'b.pdf')])
})

test('extrairArquivos ignora a marca no meio de uma frase', () => {
  const { texto, arquivos } = extrairArquivos('use [[arquivo: x]] assim', '/srv')
  assert.equal(texto, 'use [[arquivo: x]] assim')
  assert.deepEqual(arquivos, [])
})

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
  assert.equal(extname(saveMedia({ dir, buffer, mimetype: 'video/mp4', kind: 'video' })), '.mp4')
  assert.equal(extname(saveMedia({ dir, buffer, mimetype: 'video/quicktime', kind: 'video' })), '.mov')
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
  assert.equal(extname(saveMedia({ dir, buffer, mimetype: 'video/exotico', kind: 'video' })), '.mp4')
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

function comIdade(dir, nome, idadeMs, agora) {
  const caminho = join(dir, nome)
  writeFileSync(caminho, 'x')
  const quando = (agora - idadeMs) / 1000
  utimesSync(caminho, quando, quando)
  return caminho
}

test('limparMediaAntiga remove só o que passou do teto de idade', () => {
  const dir = pastaTemp()
  const agora = Date.now()
  const velho = comIdade(dir, 'velho.jpg', 40 * 24 * 60 * 60 * 1000, agora)
  const novo = comIdade(dir, 'novo.jpg', 1 * 24 * 60 * 60 * 1000, agora)

  const removidos = limparMediaAntiga({ dir, maxAgeMs: 30 * 24 * 60 * 60 * 1000, now: () => agora })

  assert.equal(removidos, 1)
  assert.ok(!existsSync(velho))
  assert.ok(existsSync(novo))
})

test('limparMediaAntiga em pasta vazia ou inexistente não lança e devolve zero', () => {
  assert.equal(limparMediaAntiga({ dir: pastaTemp(), maxAgeMs: 1000 }), 0)
  assert.equal(limparMediaAntiga({ dir: join(pastaTemp(), 'nunca-existiu'), maxAgeMs: 1000 }), 0)
})

function comTamanho(dir, nome, bytes, idadeMs, agora = Date.now()) {
  const caminho = join(dir, nome)
  writeFileSync(caminho, Buffer.alloc(bytes))
  const quando = (agora - idadeMs) / 1000
  utimesSync(caminho, quando, quando)
  return caminho
}

test('limparMediaAntiga não apaga um anexo que ainda vai sair pela outbox', () => {
  const dir = pastaTemp()
  const agora = Date.now()
  const anexo = comIdade(dir, 'anexo.pdf', 40 * 24 * 60 * 60 * 1000, agora)
  const velho = comIdade(dir, 'velho.jpg', 40 * 24 * 60 * 60 * 1000, agora)

  const removidos = limparMediaAntiga({ dir, maxAgeMs: 30 * 24 * 60 * 60 * 1000, now: () => agora, protegidos: [anexo] })

  assert.equal(removidos, 1)
  assert.ok(existsSync(anexo), 'o rascunho pendente ainda precisa dele')
  assert.ok(!existsSync(velho))
})

test('podarMidia apaga os mais antigos até caber no teto', async () => {
  const dir = pastaTemp()
  const a = comTamanho(dir, 'a.jpg', 400, 3000)
  const b = comTamanho(dir, 'b.jpg', 400, 2000)
  const c = comTamanho(dir, 'c.jpg', 400, 1000)

  const r = await podarMidia({ dir, maxBytes: 900 })

  assert.deepEqual(r, { removidos: 1, bytes: 400 })
  assert.ok(!existsSync(a), 'o mais antigo sai primeiro')
  assert.ok(existsSync(b))
  assert.ok(existsSync(c))
})

test('podarMidia abaixo do teto não apaga nada, nem o que é antigo', async () => {
  const dir = pastaTemp()
  const antigo = comTamanho(dir, 'antigo.jpg', 100, 400 * 24 * 60 * 60 * 1000)

  assert.deepEqual(await podarMidia({ dir, maxBytes: 1000 }), { removidos: 0, bytes: 0 })
  assert.ok(existsSync(antigo), 'a regra é de tamanho, não de idade')
})

test('podarMidia pula o anexo protegido e apaga o próximo mais antigo', async () => {
  const dir = pastaTemp()
  const anexo = comTamanho(dir, 'anexo.pdf', 400, 3000)
  const b = comTamanho(dir, 'b.jpg', 400, 2000)
  const c = comTamanho(dir, 'c.jpg', 400, 1000)

  const r = await podarMidia({ dir, maxBytes: 900, protegidos: [anexo] })

  assert.deepEqual(r, { removidos: 1, bytes: 400 })
  assert.ok(existsSync(anexo), 'referenciado por rascunho ou agendamento pendente')
  assert.ok(!existsSync(b))
  assert.ok(existsSync(c))
})

test('podarMidia ignora subpastas: só conta e apaga arquivos da própria pasta', async () => {
  const dir = pastaTemp()
  mkdirSync(join(dir, 'sub'))
  const dentro = comTamanho(join(dir, 'sub'), 'dentro.jpg', 5000, 9000)
  const solto = comTamanho(dir, 'solto.jpg', 10, 1000)

  assert.deepEqual(await podarMidia({ dir, maxBytes: 100 }), { removidos: 0, bytes: 0 })
  assert.ok(existsSync(solto))
  assert.ok(existsSync(dentro))
})

test('podarMidia em pasta inexistente não lança e devolve zero', async () => {
  assert.deepEqual(await podarMidia({ dir: join(pastaTemp(), 'nunca-existiu'), maxBytes: 1 }), { removidos: 0, bytes: 0 })
})
