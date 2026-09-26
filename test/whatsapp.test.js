import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import { DisconnectReason } from '@whiskeysockets/baileys'
import { classificar, aceitaDoBot, credenciaisValidas, createWhatsapp, atrasoReconexao } from '../src/whatsapp.js'

test('classificar reconhece documento, com e sem legenda, e o tamanho em Long', () => {
  const semLegenda = classificar({ message: { documentMessage: { mimetype: 'application/pdf', fileName: 'a.pdf', fileLength: 1234 } } })
  assert.deepEqual(semLegenda, { kind: 'document', text: '', mimetype: 'application/pdf', fileName: 'a.pdf', size: 1234 })

  const long = { low: 5000, high: 0, toString: () => '5000' }
  const comLegenda = classificar({ message: { documentWithCaptionMessage: { message: { documentMessage: { mimetype: 'text/csv', fileName: 'b.csv', caption: 'analisa', fileLength: long } } } } })
  assert.deepEqual(comLegenda, { kind: 'document', text: 'analisa', mimetype: 'text/csv', fileName: 'b.csv', size: 5000 })
})

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
  assert.deepEqual(r, { kind: 'image', text: 'que erro é esse?', mimetype: 'image/jpeg', size: 0 })
})

test('imagem sem legenda vira mídia com texto vazio, não é descartada', () => {
  const r = classificar({ message: { imageMessage: { mimetype: 'image/jpeg' } } })
  assert.equal(r.kind, 'image')
  assert.equal(r.text, '')
})

test('áudio e nota de voz viram mídia de áudio', () => {
  const audio = classificar({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } } })
  assert.deepEqual(audio, { kind: 'audio', text: '', mimetype: 'audio/ogg; codecs=opus', size: 0 })

  const ptt = classificar({ message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', ptt: true } } })
  assert.equal(ptt.kind, 'audio')
})

test('vídeo vira mídia com legenda, mimetype e tamanho', () => {
  const r = classificar({ message: { videoMessage: { caption: 'olha o vídeo', mimetype: 'video/mp4', fileLength: 4096 } } })
  assert.deepEqual(r, { kind: 'video', text: 'olha o vídeo', mimetype: 'video/mp4', size: 4096 })
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

// A conexão persistentemente ruim (número marcado, saída prolongada) não pode
// martelar o WhatsApp a cada 3s pra sempre.
test('atrasoReconexao cresce exponencialmente e tem teto', () => {
  const amostra = (tentativas, n = 50) => Array.from({ length: n }, () => atrasoReconexao(tentativas))

  const t0 = amostra(0)
  assert.ok(t0.every((ms) => ms >= 2400 && ms <= 3600), `tentativa 0 esperada ~3s, veio ${Math.min(...t0)}-${Math.max(...t0)}`)

  const t1 = amostra(1)
  assert.ok(t1.every((ms) => ms >= 4800 && ms <= 7200), `tentativa 1 esperada ~6s, veio ${Math.min(...t1)}-${Math.max(...t1)}`)

  const t10 = amostra(10)
  assert.ok(t10.every((ms) => ms <= 60000 * 1.2), 'nunca passa muito do teto de 60s')
  assert.ok(t10.every((ms) => ms >= 60000 * 0.8), 'no teto, ainda tem jitter, não trava num valor fixo')
})

test('atrasoReconexao nunca devolve dois valores idênticos seguidos (tem jitter de verdade)', () => {
  const valores = new Set(Array.from({ length: 20 }, () => atrasoReconexao(3)))
  assert.ok(valores.size > 1, 'sem variação nenhuma entre chamadas, o jitter não está fazendo nada')
})

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

// createWhatsapp() nunca tinha teste nenhum — só os helpers puros acima. Os
// pontos de contato com o baileys são injetáveis (mesmo padrão de runCli em
// claude.js) exatamente para isso: dirigir a máquina de estados de
// conexão/reconexão e o loop de despacho de mensagens contra um socket falso.
function socketFalso() {
  const ev = new EventEmitter()
  return {
    ev,
    sendMessage: mock.fn(async () => ({ key: { id: 'WA-FAKE' } })),
    groupFetchAllParticipating: async () => ({}),
    updateMediaMessage: async () => {},
  }
}

function montarWhatsapp(overrides = {}) {
  const dir = dirTemp()
  const sockets = []
  const criarSocket = mock.fn(() => {
    const s = socketFalso()
    sockets.push(s)
    return s
  })
  const logs = { info: [], warn: [], error: [] }
  const log = {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    error: (m) => logs.error.push(m),
    debug: () => {},
  }
  const wa = createWhatsapp({
    authDir: dir,
    mediaDir: join(dir, 'media'),
    accept: () => true,
    onMessage: async () => {},
    label: 'teste',
    log,
    criarSocket,
    autenticar: async () => ({ state: {}, saveCreds: () => {} }),
    buscarVersao: async () => ({ version: [2, 3000, 0] }),
    baixarMidia: async () => Buffer.from('x'),
    ...overrides,
  })
  return { wa, sockets, criarSocket, logs, dir }
}

// abrir() faz dois awaits reais (autenticar, buscarVersao) antes de sequer
// criar o socket — emitir num socket que ainda não existe é a própria corrida
// que este arquivo está testando não ter, então os testes esperam por ele.
async function aguardarSocket(sockets) {
  for (let i = 0; i < 20 && sockets.length === 0; i += 1) await Promise.resolve()
  if (!sockets.length) throw new Error('socket nunca foi criado')
  return sockets[0]
}

test('connect() resolve quando o socket abre', async () => {
  const { wa, sockets } = montarWhatsapp()
  const conectando = wa.connect()
  const sock = await aguardarSocket(sockets)
  sock.ev.emit('connection.update', { connection: 'open' })
  await conectando
  assert.equal(wa.state(), 'open')
})

test('close por motivo comum tenta reconectar, sem exceder o teto de tempo', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { wa, sockets, criarSocket } = montarWhatsapp()
    const conectando = wa.connect()
    const sock = await aguardarSocket(sockets)
    sock.ev.emit('connection.update', { connection: 'open' })
    await conectando
    assert.equal(criarSocket.mock.callCount(), 1)

    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 } } } })
    assert.equal(wa.state(), 'closed')

    // reconectar() já soma a primeira tentativa antes de calcular o atraso, então
    // a primeira reconexão sai perto de atrasoReconexao(1) (~6s), não do base de
    // 3s — 7200ms cobre o teto do jitter dessa tentativa (ver o teste de
    // atrasoReconexao acima).
    mock.timers.tick(7200)
    await new Promise((r) => setImmediate(r))
    assert.equal(criarSocket.mock.callCount(), 2, 'reconectou depois da queda')
  } finally {
    mock.timers.reset()
  }
})

test('loggedOut rejeita o connect() e nunca tenta reconectar', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const { wa, sockets, criarSocket } = montarWhatsapp()
    const conectando = wa.connect()
    const sock = await aguardarSocket(sockets)
    sock.ev.emit('connection.update', {
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: DisconnectReason.loggedOut } } },
    })

    await assert.rejects(conectando, (err) => err.deslogado === true)

    mock.timers.tick(60000)
    await new Promise((r) => setImmediate(r))
    assert.equal(criarSocket.mock.callCount(), 1, 'não tenta de novo depois de deslogado')
  } finally {
    mock.timers.reset()
  }
})

test('mensagem que causa exceção não impede as seguintes de serem processadas', async () => {
  const processadas = []
  const { wa, sockets } = montarWhatsapp({
    onMessage: async (m) => {
      if (m.text === 'quebra') throw new Error('boom')
      processadas.push(m.text)
    },
  })
  const conectando = wa.connect()
  const sock = await aguardarSocket(sockets)
  sock.ev.emit('connection.update', { connection: 'open' })
  await conectando

  sock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key: {}, message: { conversation: 'quebra' } },
      { key: {}, message: { conversation: 'passa' } },
    ],
  })
  // O handler do evento é assíncrono; dá um giro no loop pra ele terminar.
  await new Promise((r) => setImmediate(r))

  assert.deepEqual(processadas, ['passa'])
})

test('mensagem recusada pelo accept vai só para onOther, nunca para onMessage', async () => {
  const aceitas = []
  const outras = []
  const { wa, sockets } = montarWhatsapp({
    accept: (key) => key.remoteJid === 'dono@s.whatsapp.net',
    onMessage: async (m) => { aceitas.push(m.text) },
    onOther: async (m) => { outras.push(m) },
  })
  const conectando = wa.connect()
  const sock = await aguardarSocket(sockets)
  sock.ev.emit('connection.update', { connection: 'open' })
  await conectando

  sock.ev.emit('messages.upsert', {
    type: 'notify',
    messages: [
      { key: { remoteJid: 'dono@s.whatsapp.net' }, message: { conversation: 'do dono' } },
      { key: { remoteJid: 'outro@s.whatsapp.net' }, message: { conversation: 'de outro' }, pushName: 'Fulano' },
      { key: { remoteJid: 'outro@s.whatsapp.net', fromMe: true }, message: { conversation: 'eco do próprio bot' } },
    ],
  })
  sock.ev.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: 'outro@s.whatsapp.net' }, message: { conversation: 'histórico' } }] })
  await new Promise((r) => setImmediate(r))

  assert.deepEqual(aceitas, ['do dono'])
  assert.equal(outras.length, 1, 'nem eco do bot nem histórico viram resposta repassada')
  assert.equal(outras[0].text, 'de outro')
  assert.equal(outras[0].pushName, 'Fulano')
})

test('sendText usa o socket atual e devolve o id da mensagem enviada', async () => {
  const { wa, sockets } = montarWhatsapp()
  const conectando = wa.connect()
  const sock = await aguardarSocket(sockets)
  sock.ev.emit('connection.update', { connection: 'open' })
  await conectando

  const id = await wa.sendText('5511911111111', 'oi')
  assert.equal(id, 'WA-FAKE')
  assert.equal(sock.sendMessage.mock.callCount(), 1)
})

test('sendText sem conexão explica em vez de estourar dentro do baileys', async () => {
  const { wa } = montarWhatsapp()
  await assert.rejects(wa.sendText('5511911111111', 'oi'), /não está conectado/)
})

test('sendDocument manda o texto como arquivo .txt com legenda', async () => {
  const { wa, sockets } = montarWhatsapp()
  const conectando = wa.connect()
  const sock = await aguardarSocket(sockets)
  sock.ev.emit('connection.update', { connection: 'open' })
  await conectando

  const id = await wa.sendDocument('5511911111111', { content: 'relatório inteiro', fileName: 'api.txt', caption: '[api] prévia' })
  assert.equal(id, 'WA-FAKE')
  const [jid, conteudo] = sock.sendMessage.mock.calls[0].arguments
  assert.equal(jid, '5511911111111@s.whatsapp.net')
  assert.equal(conteudo.document.toString('utf8'), 'relatório inteiro')
  assert.equal(conteudo.mimetype, 'text/plain')
  assert.equal(conteudo.fileName, 'api.txt')
  assert.equal(conteudo.caption, '[api] prévia')
})

test('sendDocument com bytes e mimetype manda o arquivo como veio', async () => {
  const { wa, sockets } = montarWhatsapp()
  const conectando = wa.connect()
  const sock = await aguardarSocket(sockets)
  sock.ev.emit('connection.update', { connection: 'open' })
  await conectando

  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff])
  await wa.sendDocument('5511911111111', { content: bytes, fileName: 'a.pdf', mimetype: 'application/pdf' })
  const [, conteudo] = sock.sendMessage.mock.calls[0].arguments
  assert.ok(conteudo.document.equals(bytes))
  assert.equal(conteudo.mimetype, 'application/pdf')
})

test('sendDocument sem conexão explica em vez de estourar dentro do baileys', async () => {
  const { wa } = montarWhatsapp()
  await assert.rejects(wa.sendDocument('5511911111111', { content: 'x', fileName: 'a.txt' }), /não está conectado/)
})
