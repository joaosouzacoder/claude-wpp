import { mkdirSync } from 'node:fs'
import qrcode from 'qrcode-terminal'
import * as baileys from '@whiskeysockets/baileys'
import { sameNumber, senderNumber, normalizeNumber } from './numbers.js'

const makeWASocket = baileys.makeWASocket ?? baileys.default
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys

// O Baileys espera um logger no formato do pino. Evitamos a dependência.
const loggerMudo = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return loggerMudo },
}

function textoDaMensagem(msg) {
  const m = msg.message
  if (!m) return ''
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    ''
  )
}

export function createWhatsapp({ authDir, authorizedNumber, onMessage, log = console }) {
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

          const texto = textoDaMensagem(msg).trim()
          if (!texto) continue

          await onMessage(texto)
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
