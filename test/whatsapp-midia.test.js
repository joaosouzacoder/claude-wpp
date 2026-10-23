import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWhatsapp, MIDIAS_PARA_CLAUDE, MIDIAS_ARQUIVADAS } from '../src/whatsapp.js'

// Which kinds an account downloads, and the ceiling on one file. The bot
// downloads what Claude can read; the personal account archives what people
// send it, video included.
function socketFalso() {
  return {
    ev: new EventEmitter(),
    sendMessage: mock.fn(async () => ({ key: { id: 'WA-FAKE' } })),
    groupFetchAllParticipating: async () => ({}),
    updateMediaMessage: async () => {},
  }
}

async function montar(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-midia-'))
  const mediaDir = join(dir, 'media')
  const recebidas = []
  let baixou = 0
  const sockets = []

  const wa = createWhatsapp({
    authDir: dir,
    mediaDir,
    accept: () => true,
    onMessage: async (m) => { recebidas.push(m) },
    label: 'teste',
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    criarSocket: () => { const s = socketFalso(); sockets.push(s); return s },
    autenticar: async () => ({ state: {}, saveCreds: () => {} }),
    buscarVersao: async () => ({ version: [2, 3000, 0] }),
    baixarMidia: async () => { baixou += 1; return Buffer.from('conteudo') },
    ...overrides,
  })

  const aberto = wa.connect()
  // O socket só existe depois dos awaits internos de abrir().
  while (!sockets.length) await new Promise((r) => setImmediate(r))
  sockets[0].ev.emit('connection.update', { connection: 'open' })
  await aberto

  const entregar = async (message) => {
    sockets[0].ev.emit('messages.upsert', {
      type: 'notify',
      messages: [{ key: { remoteJid: '5511999999999@s.whatsapp.net', id: 'A1' }, message, messageTimestamp: 1 }],
    })
    // O laço de mensagens é assíncrono dentro do handler do evento.
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r))
  }

  return { entregar, recebidas, mediaDir, arquivos: () => { try { return readdirSync(mediaDir) } catch { return [] } }, baixado: () => baixou }
}

const VIDEO = { videoMessage: { caption: 'olha isso', mimetype: 'video/mp4', fileLength: 2048 } }

test('a conta do bot não baixa vídeo: a legenda chega como texto', async () => {
  const c = await montar({ mediaKinds: MIDIAS_PARA_CLAUDE })
  await c.entregar(VIDEO)

  assert.equal(c.baixado(), 0, 'nada de download')
  assert.deepEqual(c.arquivos(), [], 'nada no disco')
  assert.equal(c.recebidas.at(-1)?.text, 'olha isso')
  assert.equal(c.recebidas.at(-1)?.media, null)
})

test('a conta que arquiva baixa o vídeo e guarda com a extensão do mimetype', async () => {
  const c = await montar({ mediaKinds: MIDIAS_ARQUIVADAS })
  await c.entregar(VIDEO)

  assert.equal(c.baixado(), 1)
  assert.equal(c.arquivos().length, 1)
  assert.match(c.arquivos()[0], /\.mp4$/)

  const media = c.recebidas.at(-1)?.media
  assert.equal(media.kind, 'video')
  assert.equal(media.path, join(c.mediaDir, c.arquivos()[0]))
  assert.equal(c.recebidas.at(-1).text, 'olha isso', 'a legenda continua chegando')
})

test('acima do teto nada é baixado, e a mensagem diz o que era', async () => {
  const c = await montar({ mediaKinds: MIDIAS_ARQUIVADAS, maxMediaBytes: 1024 })
  await c.entregar(VIDEO)

  assert.equal(c.baixado(), 0, 'o teto é decidido antes do download, que vai todo para a memória')
  assert.deepEqual(c.arquivos(), [])
  const media = c.recebidas.at(-1)?.media
  assert.equal(media.tooLarge, true)
  assert.equal(media.size, 2048)
  assert.equal(media.kind, 'video')
})

test('o teto vale para qualquer tipo, não só documento', async () => {
  const c = await montar({ mediaKinds: MIDIAS_ARQUIVADAS, maxMediaBytes: 1024 })
  await c.entregar({ imageMessage: { mimetype: 'image/jpeg', fileLength: 5000 } })

  assert.equal(c.baixado(), 0)
  assert.equal(c.recebidas.at(-1)?.media?.tooLarge, true)
})

test('tamanho que o remetente não informou não é lido como zero e baixa normal', async () => {
  const c = await montar({ mediaKinds: MIDIAS_ARQUIVADAS, maxMediaBytes: 1024 })
  await c.entregar({ imageMessage: { mimetype: 'image/png' } })

  assert.equal(c.baixado(), 1)
  assert.match(c.arquivos()[0], /\.png$/)
})

test('tamanho não informado não escapa do teto: o download para no meio e nada é gravado', async () => {
  let lidos = 0
  const pedacos = async function* () {
    for (let i = 0; i < 100; i += 1) { lidos += 1; yield Buffer.alloc(512) }
  }
  const c = await montar({
    mediaKinds: MIDIAS_ARQUIVADAS,
    maxMediaBytes: 1024,
    baixarMidia: async () => Readable.from(pedacos()),
  })
  await c.entregar({ videoMessage: { mimetype: 'video/mp4' } })

  assert.ok(lidos < 10, `parou cedo, leu ${lidos} pedaço(s)`)
  assert.deepEqual(c.arquivos(), [])
  assert.equal(c.recebidas.at(-1)?.media?.tooLarge, true)
})

test('download em stream que cabe no teto é gravado inteiro', async () => {
  const c = await montar({
    mediaKinds: MIDIAS_ARQUIVADAS,
    baixarMidia: async () => Readable.from([Buffer.from('par'), Buffer.from('tes')]),
  })
  await c.entregar({ imageMessage: { mimetype: 'image/png' } })

  assert.equal(readFileSync(c.recebidas.at(-1).media.path, 'utf8'), 'partes')
})

test('falha no download não derruba a mensagem: ela chega sem o arquivo', async () => {
  const c = await montar({
    mediaKinds: MIDIAS_ARQUIVADAS,
    baixarMidia: async () => { throw new Error('mídia expirou') },
  })
  await c.entregar({ imageMessage: { caption: 'olha', mimetype: 'image/jpeg', fileLength: 10 } })

  assert.equal(c.recebidas.length, 1, 'a mensagem ainda é entregue para ser registrada')
  assert.equal(c.recebidas[0].text, 'olha')
  assert.equal(c.recebidas[0].media.failed, true)
  assert.equal(c.recebidas[0].media.path, undefined)
  assert.deepEqual(c.arquivos(), [])
})

test('download que trava desiste no prazo e a mensagem segue', async () => {
  const c = await montar({
    mediaKinds: MIDIAS_ARQUIVADAS,
    mediaTimeoutMs: 20,
    baixarMidia: async () => new Readable({ read() {} }),
  })
  await c.entregar({ imageMessage: { mimetype: 'image/jpeg', fileLength: 10 } })
  await new Promise((r) => setTimeout(r, 60))
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r))

  assert.equal(c.recebidas.at(-1)?.media?.failed, true)
  assert.deepEqual(c.arquivos(), [])
})

test('figurinha não é arquivada: nenhum arquivo vai pro disco', async () => {
  const c = await montar({ mediaKinds: MIDIAS_ARQUIVADAS })
  await c.entregar({ stickerMessage: { mimetype: 'image/webp', fileLength: 30 } })

  assert.equal(c.baixado(), 0)
  assert.deepEqual(c.arquivos(), [])
})

test('mensagem sem texto e sem arquivo ainda é entregue a quem registra', async () => {
  // Figurinha, localização, contato: o bot descarta (nada para o Claude
  // fazer), mas o registro da conversa precisa da mensagem de qualquer jeito.
  const registra = await montar({ mediaKinds: MIDIAS_ARQUIVADAS, entregarSemConteudo: true })
  await registra.entregar({ stickerMessage: { mimetype: 'image/webp' } })
  await registra.entregar({ locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6 } })
  assert.equal(registra.recebidas.length, 2)

  const bot = await montar({ mediaKinds: MIDIAS_PARA_CLAUDE })
  await bot.entregar({ stickerMessage: { mimetype: 'image/webp' } })
  await bot.entregar({ locationMessage: { degreesLatitude: -23.5, degreesLongitude: -46.6 } })
  assert.equal(bot.recebidas.length, 0, 'o bot segue descartando o que não dá para agir')
})
