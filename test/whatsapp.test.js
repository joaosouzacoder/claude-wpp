import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classificar } from '../src/whatsapp.js'

test('mensagem de texto simples continua sendo texto', () => {
  assert.deepEqual(classificar({ message: { conversation: 'oi claude' } }), {
    kind: 'text',
    text: 'oi claude',
    mimetype: null,
  })
})

test('texto estendido (resposta, link) continua sendo texto', () => {
  const r = classificar({ message: { extendedTextMessage: { text: 'olha esse link' } } })
  assert.equal(r.kind, 'text')
  assert.equal(r.text, 'olha esse link')
})

test('imagem vira mídia carregando a legenda e o mimetype', () => {
  const r = classificar({
    message: { imageMessage: { caption: 'que erro é esse?', mimetype: 'image/jpeg' } },
  })
  assert.deepEqual(r, { kind: 'image', text: 'que erro é esse?', mimetype: 'image/jpeg' })
})

test('imagem sem legenda vira mídia com texto vazio, não é descartada', () => {
  const r = classificar({ message: { imageMessage: { mimetype: 'image/jpeg' } } })
  assert.equal(r.kind, 'image')
  assert.equal(r.text, '')
})

test('áudio e nota de voz viram mídia de áudio', () => {
  const audio = classificar({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } })
  assert.deepEqual(audio, { kind: 'audio', text: '', mimetype: 'audio/ogg; codecs=opus' })

  const ptt = classificar({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } } })
  assert.equal(ptt.kind, 'audio')
})

test('vídeo segue como antes: só a legenda, sem baixar mídia', () => {
  const r = classificar({ message: { videoMessage: { caption: 'olha o vídeo', mimetype: 'video/mp4' } } })
  assert.equal(r.kind, 'text')
  assert.equal(r.text, 'olha o vídeo')
})

test('mensagem sem conteúdo conhecido vira texto vazio', () => {
  assert.equal(classificar({ message: { stickerMessage: {} } }).text, '')
  assert.equal(classificar({ message: null }).text, '')
  assert.equal(classificar({}).text, '')
})
