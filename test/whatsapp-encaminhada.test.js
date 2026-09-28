import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWhatsapp, encaminhada } from '../src/whatsapp.js'

test('encaminhada lê isForwarded e forwardingScore de qualquer tipo de mensagem', () => {
  assert.equal(encaminhada({ message: { imageMessage: { caption: 'Meu amor', contextInfo: { isForwarded: true } } } }), true)
  assert.equal(encaminhada({ message: { extendedTextMessage: { text: 'corrente', contextInfo: { forwardingScore: 12 } } } }), true)
  assert.equal(encaminhada({ message: { videoMessage: { contextInfo: { isForwarded: true } } } }), true)
  assert.equal(encaminhada({ message: { documentWithCaptionMessage: { message: { documentMessage: { contextInfo: { isForwarded: true } } } } } }), true)

  assert.equal(encaminhada({ message: { conversation: 'oi' } }), false)
  assert.equal(encaminhada({ message: { imageMessage: { caption: 'foto', contextInfo: {} } } }), false)
  assert.equal(encaminhada({ message: { extendedTextMessage: { text: 'x', contextInfo: { forwardingScore: 0 } } } }), false)
  assert.equal(encaminhada({}), false)
})

test('quem o bot não aceita chega ao onOther com o sinal de encaminhamento', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wa-enc-'))
  const recebidas = []
  const sockets = []
  const wa = createWhatsapp({
    authDir: dir,
    mediaDir: join(dir, 'media'),
    accept: () => false,
    onMessage: async () => {},
    onOther: async (m) => { recebidas.push(m) },
    label: 'teste',
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    criarSocket: () => {
      const s = { ev: new EventEmitter(), sendMessage: mock.fn(), groupFetchAllParticipating: async () => ({}), updateMediaMessage: async () => {} }
      sockets.push(s)
      return s
    },
    autenticar: async () => ({ state: {}, saveCreds: () => {} }),
    buscarVersao: async () => ({ version: [2, 3000, 0] }),
    baixarMidia: async () => Buffer.from('x'),
  })
  const aberto = wa.connect()
  while (!sockets.length) await new Promise((r) => setImmediate(r))
  sockets[0].ev.emit('connection.update', { connection: 'open' })
  await aberto

  const key = { remoteJid: '5511911111111@s.whatsapp.net', id: 'A1', fromMe: false }
  sockets[0].ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key, message: { imageMessage: { caption: 'Meu amor 😍', contextInfo: { isForwarded: true } } }, messageTimestamp: 1 },
      { key: { ...key, id: 'A2' }, message: { conversation: 'você vai?' }, messageTimestamp: 2 },
    ],
  })
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r))

  assert.equal(recebidas.length, 2)
  assert.equal(recebidas[0].encaminhada, true)
  assert.equal(recebidas[0].text, 'Meu amor 😍')
  assert.equal(recebidas[1].encaminhada, false)
})
