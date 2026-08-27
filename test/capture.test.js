import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { normalize, createCapture } from '../src/capture.js'

const noGrupo = (message, extra = {}) => ({
  key: { remoteJid: '1-2@g.us', fromMe: false, id: 'A1', participant: '5511911111111@s.whatsapp.net' },
  messageTimestamp: 1700000000,
  pushName: 'John',
  message,
  ...extra,
})

test('mensagem de texto em grupo vira linha completa', () => {
  const r = normalize(noGrupo({ conversation: 'a migração fica pra semana que vem' }))
  assert.deepEqual(r, {
    waId: 'A1',
    chatJid: '1-2@g.us',
    chatKind: 'group',
    senderJid: '5511911111111@s.whatsapp.net',
    senderName: 'John',
    fromMe: 0,
    ts: 1700000000,
    kind: 'text',
    body: 'a migração fica pra semana que vem',
    quotedWaId: null,
  })
})

test('extendedTextMessage guarda a mensagem citada', () => {
  const r = normalize(noGrupo({
    extendedTextMessage: { text: 'concordo', contextInfo: { stanzaId: 'ORIGINAL' } },
  }))
  assert.equal(r.body, 'concordo')
  assert.equal(r.quotedWaId, 'ORIGINAL')
})

test('minha própria mensagem é gravada, é o corpus do meu estilo', () => {
  const r = normalize(noGrupo({ conversation: 'fechado' }, { key: { remoteJid: '1-2@g.us', fromMe: true, id: 'B1' } }))
  assert.equal(r.fromMe, 1)
  assert.equal(r.senderJid, null)
})

test('áudio vira placeholder com a duração, sem baixar arquivo', () => {
  const r = normalize(noGrupo({ audioMessage: { seconds: 14, mimetype: 'audio/ogg' } }))
  assert.equal(r.kind, 'audio')
  assert.equal(r.body, '[áudio 0:14]')
})

test('imagem com legenda guarda a legenda', () => {
  const r = normalize(noGrupo({ imageMessage: { caption: 'olha o gráfico' } }))
  assert.equal(r.kind, 'image')
  assert.equal(r.body, '[imagem] olha o gráfico')
})

test('documento guarda o nome do arquivo', () => {
  const r = normalize(noGrupo({ documentMessage: { fileName: 'contrato.pdf' } }))
  assert.equal(r.kind, 'document')
  assert.equal(r.body, '[documento: contrato.pdf]')
})

test('conversa direta é dm e o remetente é o próprio contato', () => {
  const r = normalize({
    key: { remoteJid: '5511911111111@s.whatsapp.net', fromMe: false, id: 'C1' },
    messageTimestamp: 1700000001,
    pushName: 'Jane',
    message: { conversation: 'levo o macbook sim' },
  })
  assert.equal(r.chatKind, 'dm')
  assert.equal(r.chatJid, '5511911111111@s.whatsapp.net')
  assert.equal(r.senderJid, '5511911111111@s.whatsapp.net')
})

test('conversa direta em @lid usa o número real quando ele vem junto', () => {
  const r = normalize({
    key: { remoteJid: '99999@lid', remoteJidAlt: '5511911111111@s.whatsapp.net', fromMe: false, id: 'C2' },
    messageTimestamp: 1700000002,
    message: { conversation: 'oi' },
  })
  assert.equal(r.chatJid, '5511911111111@s.whatsapp.net')
})

test('mensagem de protocolo é descartada', () => {
  assert.equal(normalize(noGrupo({ protocolMessage: { type: 0 } })), null)
  assert.equal(normalize(noGrupo({ senderKeyDistributionMessage: {} })), null)
  assert.equal(normalize(noGrupo({})), null)
  assert.equal(normalize({ key: { remoteJid: '1-2@g.us', id: 'X' } }), null)
})

test('timestamp em Long vira número', () => {
  const r = normalize(noGrupo({ conversation: 'oi' }, { messageTimestamp: { low: 1700000000, high: 0 } }))
  assert.equal(r.ts, 1700000000)
})

// --- gravação ---

const comBanco = () => {
  const db = openDb(':memory:')
  return { db, capture: createCapture({ db, now: () => 555 }) }
}

test('grava a mensagem e cria a conversa que ainda não existia', () => {
  const { db, capture } = comBanco()
  assert.equal(capture.record(noGrupo({ conversation: 'oi' })), true)

  const msg = db.prepare('select * from messages').get()
  assert.equal(msg.body, 'oi')
  assert.equal(msg.chat_jid, '1-2@g.us')

  const chat = db.prepare('select * from chats').get()
  assert.equal(chat.jid, '1-2@g.us')
  assert.equal(chat.kind, 'group')
  assert.equal(chat.updated_at, 555)
  db.close()
})

test('a mesma mensagem reentregue não duplica', () => {
  const { db, capture } = comBanco()
  capture.record(noGrupo({ conversation: 'oi' }))
  assert.equal(capture.record(noGrupo({ conversation: 'oi' })), false)
  assert.equal(db.prepare('select count(*) c from messages').get().c, 1)
  db.close()
})

test('gravar não apaga o nome do grupo que já sabíamos', () => {
  const { db, capture } = comBanco()
  capture.rememberChat({ jid: '1-2@g.us', name: 'Team Leads' })
  capture.record(noGrupo({ conversation: 'oi' }))
  assert.equal(db.prepare('select name from chats').get().name, 'Team Leads')
  db.close()
})

test('o nome do grupo pode ser atualizado depois', () => {
  const { db, capture } = comBanco()
  capture.record(noGrupo({ conversation: 'oi' }))
  capture.rememberChat({ jid: '1-2@g.us', name: 'Team Leads' })
  assert.equal(db.prepare('select name from chats').get().name, 'Team Leads')
  db.close()
})

test('mensagem sem texto nem mídia conhecida não é gravada', () => {
  const { db, capture } = comBanco()
  assert.equal(capture.record(noGrupo({ protocolMessage: { type: 0 } })), false)
  assert.equal(db.prepare('select count(*) c from messages').get().c, 0)
  db.close()
})
