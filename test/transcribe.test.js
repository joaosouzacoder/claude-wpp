import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { transcribe } from '../src/transcribe.js'

function audioFalso(conteudo = 'ogg-bytes') {
  const caminho = join(mkdtempSync(join(tmpdir(), 'transcribe-')), 'audio.ogg')
  writeFileSync(caminho, conteudo)
  return caminho
}

function respostaOk(corpo) {
  return async () => ({ ok: true, status: 200, json: async () => corpo })
}

test('devolve o texto transcrito pela API', async () => {
  const r = await transcribe({
    path: audioFalso(),
    apiKey: 'sk-teste',
    fetchImpl: respostaOk({ text: 'roda os testes do projeto' }),
  })

  assert.deepEqual(r, { ok: true, text: 'roda os testes do projeto', error: null })
})

test('posta o áudio e o modelo no endpoint de transcrição da OpenAI', async () => {
  let visto = null
  await transcribe({
    path: audioFalso('conteudo-do-audio'),
    apiKey: 'sk-teste',
    model: 'gpt-4o-transcribe',
    fetchImpl: async (url, opts) => {
      visto = { url, opts }
      return { ok: true, status: 200, json: async () => ({ text: 'oi' }) }
    },
  })

  assert.equal(visto.url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(visto.opts.method, 'POST')
  assert.equal(visto.opts.headers.authorization, 'Bearer sk-teste')
  assert.equal(visto.opts.body.get('model'), 'gpt-4o-transcribe')

  const arquivo = visto.opts.body.get('file')
  assert.equal(arquivo.name, 'audio.ogg')
  assert.equal(await arquivo.text(), 'conteudo-do-audio')
})

test('erro HTTP da API vira falha com a mensagem da OpenAI', async () => {
  const r = await transcribe({
    path: audioFalso(),
    apiKey: 'sk-invalida',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: 'Incorrect API key provided' } }),
    }),
  })

  assert.equal(r.ok, false)
  assert.match(r.error, /Incorrect API key provided/)
})

test('erro HTTP sem corpo json legível ainda reporta o status', async () => {
  const r = await transcribe({
    path: audioFalso(),
    apiKey: 'sk-teste',
    fetchImpl: async () => ({ ok: false, status: 502, json: async () => { throw new Error('não é json') } }),
  })

  assert.equal(r.ok, false)
  assert.match(r.error, /502/)
})

test('falha de rede vira falha sem estourar exceção', async () => {
  const r = await transcribe({
    path: audioFalso(),
    apiKey: 'sk-teste',
    fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND') },
  })

  assert.equal(r.ok, false)
  assert.match(r.error, /ENOTFOUND/)
})

test('resposta sem texto vira falha', async () => {
  const r = await transcribe({ path: audioFalso(), apiKey: 'sk-teste', fetchImpl: respostaOk({}) })

  assert.equal(r.ok, false)
})

test('transcrição em branco vira falha, não texto vazio', async () => {
  const r = await transcribe({ path: audioFalso(), apiKey: 'sk-teste', fetchImpl: respostaOk({ text: '   ' }) })

  assert.equal(r.ok, false)
})

test('sem chave da OpenAI falha antes de tocar na rede', async () => {
  let chamou = false
  const r = await transcribe({
    path: audioFalso(),
    apiKey: null,
    fetchImpl: async () => { chamou = true },
  })

  assert.equal(chamou, false)
  assert.equal(r.ok, false)
})

test('arquivo inexistente vira falha sem tocar na rede', async () => {
  let chamou = false
  const r = await transcribe({
    path: '/caminho/que/nao/existe.ogg',
    apiKey: 'sk-teste',
    fetchImpl: async () => { chamou = true },
  })

  assert.equal(chamou, false)
  assert.equal(r.ok, false)
})

test('estourar o tempo limite vira falha explicando o timeout', async () => {
  const r = await transcribe({
    path: audioFalso(),
    apiKey: 'sk-teste',
    timeoutMs: 20,
    fetchImpl: (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  })

  assert.equal(r.ok, false)
  assert.match(r.error, /tempo limite/i)
})
