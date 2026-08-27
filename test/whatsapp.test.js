import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { classificar, aceitaDoBot, credenciaisValidas } from '../src/whatsapp.js'

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

// --- política de aceitação do bot ---
// Esta é a fronteira de segurança do projeto: quem passa daqui roda comando
// nesta máquina. A conta pessoal usa outra política e não chama o handler.

test('o bot aceita o número autorizado', () => {
  assert.equal(aceitaDoBot({ remoteJid: '5511911111111@s.whatsapp.net' }, '5511911111111'), true)
})

test('o bot ignora qualquer outro remetente', () => {
  assert.equal(aceitaDoBot({ remoteJid: '5511999999999@s.whatsapp.net' }, '5511911111111'), false)
})

test('o bot ignora grupo, mesmo com o número autorizado dentro', () => {
  const key = { remoteJid: '1-2@g.us', participant: '5511911111111@s.whatsapp.net' }
  assert.equal(aceitaDoBot(key, '5511911111111'), false)
})

test('o bot ignora a própria mensagem, senão responde a si mesmo', () => {
  const key = { remoteJid: '5511911111111@s.whatsapp.net', fromMe: true }
  assert.equal(aceitaDoBot(key, '5511911111111'), false)
})

test('o bot tolera o nono dígito do celular brasileiro', () => {
  assert.equal(aceitaDoBot({ remoteJid: '551111111111@s.whatsapp.net' }, '5511911111111'), true)
})

test('o bot recusa quando só existe @lid, sem número real junto', () => {
  assert.equal(aceitaDoBot({ remoteJid: '99999@lid' }, '5511911111111'), false)
})

// --- credenciais realmente pareadas ---
// Baileys escreve creds.json assim que abre o diretório, ANTES do QR ser lido.
// Confiar na existência do arquivo faz o daemon tentar conectar uma conta que
// ninguém pareou, cuspir QR no journal e morrer no timeout.

const dirTemp = () => mkdtempSync(join(tmpdir(), 'auth-'))

test('diretório que não existe não está pareado', () => {
  assert.equal(credenciaisValidas(join(tmpdir(), 'nao-existe-mesmo-123')), false)
})

test('diretório sem creds.json não está pareado', () => {
  assert.equal(credenciaisValidas(dirTemp()), false)
})

test('creds.json vazio não está pareado', () => {
  const dir = dirTemp()
  writeFileSync(join(dir, 'creds.json'), '')
  assert.equal(credenciaisValidas(dir), false)
})

test('creds.json corrompido não está pareado', () => {
  const dir = dirTemp()
  writeFileSync(join(dir, 'creds.json'), '{ isso não é json')
  assert.equal(credenciaisValidas(dir), false)
})

test('creds recém-criado, antes de qualquer QR, não está pareado', () => {
  const dir = dirTemp()
  writeFileSync(join(dir, 'creds.json'), JSON.stringify({ registered: false, noiseKey: {}, registrationId: 255 }))
  assert.equal(credenciaisValidas(dir), false)
})

// O Baileys só inicializa `registered: false` e nunca o marca true no fluxo de
// QR — é campo do fluxo de pairing code. Quem diz que o login completou é o par
// me.id + account, escrito quando o aparelho é aceito do outro lado.
test('login por QR conta como pareado mesmo com registered false', () => {
  const dir = dirTemp()
  writeFileSync(join(dir, 'creds.json'), JSON.stringify({
    registered: false,
    me: { id: '5511911111111:3@s.whatsapp.net', name: 'Fulano' },
    account: { details: 'x', accountSignature: 'y', deviceSignature: 'z' },
  }))
  assert.equal(credenciaisValidas(dir), true)
})

test('me sem account não conta: o aparelho não foi assinado', () => {
  const dir = dirTemp()
  writeFileSync(join(dir, 'creds.json'), JSON.stringify({ me: { id: '5511911111111@s.whatsapp.net' } }))
  assert.equal(credenciaisValidas(dir), false)
})
