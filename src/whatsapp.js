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
  // A document sent with a caption arrives wrapped one level deeper.
  const doc = m.documentMessage ?? m.documentWithCaptionMessage?.message?.documentMessage
  if (doc) {
    return {
      kind: 'document',
      text: doc.caption ?? '',
      mimetype: doc.mimetype ?? null,
      fileName: doc.fileName ?? null,
      // protobuf Long or number, depending on how Baileys decoded it.
      size: Number(doc.fileLength?.toString?.() ?? doc.fileLength ?? 0) || 0,
    }
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

// A persistent failure (WhatsApp throttling this number, a sustained outage)
// must not turn into hammering the endpoint every 3s forever — exponential
// backoff with jitter, capped so it never goes past a minute between tries.
// A document from the phone is downloaded into memory before it is written;
// past this it is refused instead.
export const LIMITE_DOCUMENTO = 50 * 1024 * 1024

const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 60000

export function atrasoReconexao(tentativas) {
  const exponencial = Math.min(RECONNECT_BASE_MS * 2 ** tentativas, RECONNECT_MAX_MS)
  return Math.round(exponencial * (0.8 + Math.random() * 0.4))
}

// Baileys writes creds.json the moment the auth folder is opened, long before
// anyone scans the QR, so the file's existence proves nothing. `registered` is
// no better: it is only ever initialised to false and belongs to the pairing-code
// flow, never set by a QR login. What a completed login does leave behind is the
// pair me.id + account — the identity and the signature of the linked device.
export function credenciaisValidas(authDir) {
  try {
    const creds = JSON.parse(readFileSync(join(authDir, 'creds.json'), 'utf8'))
    return Boolean(creds?.me?.id) && Boolean(creds?.account)
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
  // Messages `accept` refused. They never reach onMessage — the only path to
  // Claude — so this can only ever relay text, not act on it.
  onOther = null,
  downloadMedia = true,
  onHistory,
  onChats,
  label = 'WhatsApp',
  log = console,
  // The four points where this module actually touches Baileys/the network.
  // Overridable the same way claude.js's runCli or sessions.js's now() are,
  // so a test can drive the connection/reconnect state machine and the
  // message dispatch loop against a fake socket instead of a real one.
  criarSocket = makeWASocket,
  autenticar = useMultiFileAuthState,
  buscarVersao = fetchLatestBaileysVersion,
  baixarMidia = downloadMediaMessage,
}) {
  let sock = null
  let estado = 'closed'
  let tentativas = 0

  // Reconnecting replaces the socket, and with it the event emitter. Anything
  // waiting on connect() therefore cannot listen on a particular socket — it
  // would go deaf the moment the first one is dropped. The waiter lives here
  // instead, and every socket's handler settles it.
  let esperando = null

  // The one thing that must never happen: a dropped connection with nothing
  // left scheduled to bring it back. abrir() itself can throw before ever
  // creating a socket (the auth-state read or the version fetch failing) —
  // that used to just get logged, leaving the bot silently offline forever
  // with the process still alive. Retrying here, on abrir() rejecting, is
  // what actually closes that gap; the 'close' handler below is the other
  // caller, for a socket that got created and then dropped.
  function reconectar() {
    tentativas += 1
    const espera = atrasoReconexao(tentativas)
    log.warn(`[${label}] reconectando em ${Math.round(espera / 1000)}s (tentativa ${tentativas})...`)
    setTimeout(() => {
      abrir().catch((e) => {
        log.error(`[${label}] tentativa de reconexão falhou: ${e.message ?? e}`)
        reconectar()
      })
    }, espera)
  }

  function assentar(qual, arg) {
    if (!esperando) return
    clearTimeout(esperando.timer)
    const { resolve, reject } = esperando
    esperando = null
    if (qual === 'resolve') resolve(arg)
    else reject(arg)
  }

  async function abrir() {
    mkdirSync(authDir, { recursive: true })
    const { state, saveCreds } = await autenticar(authDir)
    const { version } = await buscarVersao()

    estado = 'connecting'
    sock = criarSocket({ version, auth: state, logger: loggerMudo, markOnlineOnConnect: false })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        log.info(`[${label}] Leia o QR abaixo:`)
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') {
        estado = 'open'
        tentativas = 0
        log.info(`[${label}] conectado.`)
        assentar('resolve')
        if (onChats) sincronizarGrupos().catch((e) => log.warn?.(`[${label}] grupos: ${e.message}`))
      }

      if (connection === 'close') {
        estado = 'closed'
        const motivo = lastDisconnect?.error?.output?.statusCode
        if (motivo === DisconnectReason.loggedOut || motivo === DisconnectReason.connectionReplaced) {
          // Credentials are dead (unlinked from the phone) or this session was
          // just taken over by another device linking the same account —
          // reconnecting would only loop against a connection that keeps
          // getting rejected or replaced, and whoever awaited connect() would
          // wait for an `open` that is never coming.
          const motivoTexto = motivo === DisconnectReason.loggedOut ? 'encerrada no aparelho' : 'substituída por outro aparelho vinculado'
          log.error(`[${label}] sessão ${motivoTexto}.`)
          assentar('reject', Object.assign(
            new Error(`sessão do ${label} foi ${motivoTexto}`), { deslogado: true },
          ))
          return
        }
        // 515 right after pairing is WhatsApp asking for a restart, not a fault.
        log.warn(`[${label}] caiu (${motivo}).`)
        reconectar()
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
          if (!accept(msg.key, msg)) {
            if (onOther && !msg.key?.fromMe && type === 'notify') {
              const { kind, text } = classificar(msg)
              await onOther({ key: msg.key, kind, text: text.trim(), pushName: msg.pushName ?? null })
            }
            continue
          }

          if (!downloadMedia) {
            await onMessage({ raw: msg })
            continue
          }

          const { kind, text, mimetype, fileName, size } = classificar(msg)

          let media = null
          if (kind === 'document' && size > LIMITE_DOCUMENTO) {
            // The download is buffered whole in memory; decide before it.
            media = { kind, mimetype, fileName, size, tooLarge: true }
          } else if (kind !== 'text') {
            const buffer = await baixarMidia(msg, 'buffer', {}, {
              logger: loggerMudo,
              reuploadRequest: sock.updateMediaMessage,
            })
            media = { kind, mimetype, fileName, path: saveMedia({ dir: mediaDir, buffer, mimetype, kind, fileName }) }
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

  }

  // Arms the waiter before opening, so a connection that comes up immediately
  // cannot settle into the void.
  function connect() {
    return new Promise((resolve, reject) => {
      esperando = {
        resolve,
        reject,
        timer: setTimeout(() => assentar('reject', new Error(`timeout conectando (${label})`)), 120000),
      }
      abrir().catch((err) => assentar('reject', err))
    })
  }

  async function sendText(destino, texto, { quoted } = {}) {
    if (!sock) throw new Error('WhatsApp não está conectado')
    const r = await sock.sendMessage(jidDe(destino), { text: texto }, quoted ? { quoted } : undefined)
    return r?.key?.id ?? null
  }

  // `content` is either text (a long reply) or the raw bytes of any file.
  async function sendDocument(destino, { content, fileName, caption, mimetype = 'text/plain' }) {
    if (!sock) throw new Error('WhatsApp não está conectado')
    const r = await sock.sendMessage(jidDe(destino), {
      document: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'),
      mimetype,
      fileName,
      caption,
    })
    return r?.key?.id ?? null
  }

  async function deleteMessage(destino, waId) {
    if (!sock) throw new Error('WhatsApp não está conectado')
    const jid = jidDe(destino)
    await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id: waId } })
  }

  return { connect, sendText, sendDocument, deleteMessage, state: () => estado }
}

function contatoComoChat(c) {
  const nome = c?.name ?? c?.notify ?? c?.verifiedName
  if (!c?.id || !nome || c.id.includes('@lid')) return null
  return { jid: c.id, name: nome, kind: 'dm' }
}
