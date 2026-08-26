import { mkdirSync } from 'node:fs'
import qrcode from 'qrcode-terminal'
import * as baileys from '@whiskeysockets/baileys'
import { sameNumber, senderNumber, normalizeNumber } from './numbers.js'
import { saveMedia } from './media.js'

const makeWASocket = baileys.makeWASocket ?? baileys.default
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = baileys

// Baileys expects a pino-shaped logger. We avoid the dependency.
const loggerMudo = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return loggerMudo },
}

// Separates what can be decided without touching the network from the download.
export function classificar(msg) {
  const m = msg?.message
  if (!m) return { kind: 'text', text: '', mimetype: null }

  if (m.imageMessage) {
    return { kind: 'image', text: m.imageMessage.caption ?? '', mimetype: m.imageMessage.mimetype ?? null }
  }
  if (m.audioMessage) {
    return { kind: 'audio', text: '', mimetype: m.audioMessage.mimetype ?? null }
  }

  return {
    kind: 'text',
    text: m.conversation ?? m.extendedTextMessage?.text ?? m.videoMessage?.caption ?? '',
    mimetype: null,
  }
}

export function createWhatsapp({ authDir, mediaDir, authorizedNumber, onMessage, log = console }) {
  let sock = null
  let estado = 'closed'

  async function connect() {
    mkdirSync(authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    estado = 'connecting'
    sock = makeWASocket({ version, auth: state, logger: loggerMudo, markOnlineOnConnect: false })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        log.info('Leia o QR abaixo com o WhatsApp do número do bot:')
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') {
        estado = 'open'
        log.info('WhatsApp conectado.')
      }

      if (connection === 'close') {
        estado = 'closed'
        const motivo = lastDisconnect?.error?.output?.statusCode
        if (motivo === DisconnectReason.loggedOut) {
          log.error('Sessão do WhatsApp encerrada. Rode `npm run pair` para parear de novo.')
          return
        }
        log.warn(`WhatsApp caiu (${motivo}). Reconectando em 3s...`)
        setTimeout(() => { connect().catch((e) => log.error(e.message ?? e)) }, 3000)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        try {
          if (msg.key?.fromMe) continue
          if (String(msg.key?.remoteJid ?? '').endsWith('@g.us')) continue

          const numero = senderNumber(msg.key)
          if (!sameNumber(numero, authorizedNumber)) {
            log.debug?.(`ignorado: remetente ${numero ?? 'desconhecido'}`)
            continue
          }

          const { kind, text, mimetype } = classificar(msg)

          let media = null
          if (kind !== 'text') {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
              logger: loggerMudo,
              reuploadRequest: sock.updateMediaMessage,
            })
            media = { kind, mimetype, path: saveMedia({ dir: mediaDir, buffer, mimetype, kind }) }
            log.debug?.(`${kind} salvo em ${media.path}`)
          }

          const texto = text.trim()
          if (!texto && !media) continue

          await onMessage({ text: texto, media })
        } catch (err) {
          log.error(`falha ao tratar mensagem: ${err.stack ?? err.message}`)
        }
      }
    })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout conectando no WhatsApp')), 120000)
      const ouvir = ({ connection }) => {
        if (connection === 'open') {
          clearTimeout(timer)
          sock.ev.off('connection.update', ouvir)
          resolve()
        }
      }
      sock.ev.on('connection.update', ouvir)
    })
  }

  async function sendText(numero, texto) {
    if (!sock) throw new Error('WhatsApp não está conectado')
    const jid = `${normalizeNumber(numero)}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: texto })
  }

  return { connect, sendText, state: () => estado }
}
