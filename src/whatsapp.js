import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

// The security boundary of the project: whoever gets past this runs commands on
// this machine. The personal account uses `aceitaTudo` instead and never reaches
// the handler — it only records.
export function aceitaDoBot(key, authorizedNumber) {
  if (!key) return false
  if (key.fromMe) return false
  if (String(key.remoteJid ?? '').endsWith('@g.us')) return false
  return sameNumber(senderNumber(key), authorizedNumber)
}

export const aceitaTudo = () => true

// Baileys writes creds.json the moment the auth folder is opened, long before
// anyone scans the QR. Only `registered` says the pairing actually completed —
// trusting the file's existence makes the daemon dial an account nobody linked.
export function credenciaisValidas(authDir) {
  try {
    return JSON.parse(readFileSync(join(authDir, 'creds.json'), 'utf8')).registered === true
  } catch {
    return false
  }
}

export function jidDe(destino) {
  const texto = String(destino ?? '')
  return texto.includes('@') ? texto : `${normalizeNumber(texto)}@s.whatsapp.net`
}

// Quoting needs the original message object, and we never keep raw payloads.
// The stub below carries the fields WhatsApp actually reads back.
export function citacaoDe(linha) {
  if (!linha) return undefined
  return {
    key: {
      remoteJid: linha.chat_jid,
      id: linha.wa_id,
      fromMe: Boolean(linha.from_me),
      ...(linha.sender_jid ? { participant: linha.sender_jid } : {}),
    },
    message: { conversation: linha.body ?? '' },
  }
}

export function createWhatsapp({
  authDir,
  mediaDir,
  onMessage,
  accept = () => false,
  downloadMedia = true,
  onHistory,
  onChats,
  label = 'WhatsApp',
  log = console,
}) {
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
        log.info(`[${label}] Leia o QR abaixo:`)
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') {
        estado = 'open'
        log.info(`[${label}] conectado.`)
        if (onChats) sincronizarGrupos().catch((e) => log.warn?.(`[${label}] grupos: ${e.message}`))
      }

      if (connection === 'close') {
        estado = 'closed'
        const motivo = lastDisconnect?.error?.output?.statusCode
        if (motivo === DisconnectReason.loggedOut) {
          log.error(`[${label}] sessão encerrada. Rode o pareamento de novo.`)
          return
        }
        log.warn(`[${label}] caiu (${motivo}). Reconectando em 3s...`)
        setTimeout(() => { connect().catch((e) => log.error(e.message ?? e)) }, 3000)
      }
    })

    // Names come from a different place than messages: without them a chat is
    // just a jid, and "the leaders group" resolves to nothing.
    async function sincronizarGrupos() {
      const grupos = await sock.groupFetchAllParticipating()
      onChats(Object.values(grupos ?? {}).map((g) => ({ jid: g.id, name: g.subject, kind: 'group' })))
    }

    if (onChats) {
      sock.ev.on('groups.upsert', (gs) => onChats(gs.map((g) => ({ jid: g.id, name: g.subject, kind: 'group' }))))
      sock.ev.on('groups.update', (gs) => {
        onChats(gs.filter((g) => g.subject).map((g) => ({ jid: g.id, name: g.subject, kind: 'group' })))
      })
      sock.ev.on('contacts.upsert', (cs) => onChats(cs.map(contatoComoChat).filter(Boolean)))
    }

    // Linking a device replays a slice of recent history. It is the only way the
    // log starts with anything in it, so it goes through the same path.
    if (onHistory) {
      sock.ev.on('messaging-history.set', ({ messages, contacts, chats }) => {
        if (onChats) {
          onChats([
            ...(contacts ?? []).map(contatoComoChat).filter(Boolean),
            ...(chats ?? []).filter((c) => c.name).map((c) => ({ jid: c.id, name: c.name })),
          ])
        }
        onHistory(messages ?? [])
      })
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' && type !== 'append') return
      for (const msg of messages) {
        try {
          if (!accept(msg.key, msg)) continue

          if (!downloadMedia) {
            await onMessage({ raw: msg })
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

          await onMessage({ text: texto, media, raw: msg })
        } catch (err) {
          log.error(`[${label}] falha ao tratar mensagem: ${err.stack ?? err.message}`)
        }
      }
    })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout conectando (${label})`)), 120000)
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

  async function sendText(destino, texto, { quoted } = {}) {
    if (!sock) throw new Error('WhatsApp não está conectado')
    const r = await sock.sendMessage(jidDe(destino), { text: texto }, quoted ? { quoted } : undefined)
    return r?.key?.id ?? null
  }

  async function deleteMessage(destino, waId) {
    if (!sock) throw new Error('WhatsApp não está conectado')
    const jid = jidDe(destino)
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: waId } })
  }

  return { connect, sendText, deleteMessage, state: () => estado }
}

function contatoComoChat(c) {
  const nome = c?.name ?? c?.notify ?? c?.verifiedName
  if (!c?.id || !nome || c.id.includes('@lid')) return null
  return { jid: c.id, name: nome, kind: 'dm' }
}
