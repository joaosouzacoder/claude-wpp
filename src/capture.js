// Turns a Baileys message into one row. Nothing here touches the network: the
// personal account records and stays quiet, so this is the whole ingest path.

function duracao(segundos) {
  const s = Number(segundos ?? 0)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

// Media is never downloaded — a placeholder keeps the conversation readable
// without putting other people's files on this disk.
const TIPOS = [
  ['imageMessage', 'image', (m) => ['[imagem]', m.caption].filter(Boolean).join(' ')],
  ['videoMessage', 'video', (m) => [`[vídeo ${duracao(m.seconds)}]`, m.caption].filter(Boolean).join(' ')],
  ['audioMessage', 'audio', (m) => `[áudio ${duracao(m.seconds)}]`],
  ['documentMessage', 'document', (m) => `[documento: ${m.fileName ?? 'sem nome'}]`],
  ['stickerMessage', 'sticker', () => '[figurinha]'],
  ['locationMessage', 'location', () => '[localização]'],
  ['contactMessage', 'contact', (m) => `[contato: ${m.displayName ?? 'sem nome'}]`],
]

function conteudo(m) {
  if (m.conversation) {
    return { kind: 'text', body: m.conversation, contextInfo: null }
  }
  if (m.extendedTextMessage) {
    return {
      kind: 'text',
      body: m.extendedTextMessage.text ?? '',
      contextInfo: m.extendedTextMessage.contextInfo ?? null,
    }
  }
  for (const [campo, kind, corpo] of TIPOS) {
    if (m[campo]) return { kind, body: corpo(m[campo]), contextInfo: m[campo].contextInfo ?? null }
  }
  return null
}

function instante(messageTimestamp) {
  if (typeof messageTimestamp === 'number') return messageTimestamp
  if (typeof messageTimestamp === 'bigint') return Number(messageTimestamp)
  return Number(messageTimestamp?.toNumber?.() ?? messageTimestamp?.low ?? 0)
}

// remoteJid can arrive as an "@lid", which identifies nobody. Prefer the
// companion field carrying the real phone whenever WhatsApp sends it.
function semLid(...candidatos) {
  for (const jid of candidatos) {
    if (typeof jid === 'string' && jid && !jid.includes('@lid')) return jid
  }
  return candidatos.find((j) => typeof j === 'string' && j) ?? null
}

export function normalize(msg) {
  const key = msg?.key
  const m = msg?.message
  if (!key?.remoteJid || !key?.id || !m) return null

  const corpo = conteudo(m)
  if (!corpo) return null

  const ehGrupo = key.remoteJid.endsWith('@g.us')
  const chatJid = ehGrupo ? key.remoteJid : semLid(key.remoteJidAlt, key.remoteJid)
  const fromMe = key.fromMe ? 1 : 0

  let senderJid = null
  if (!fromMe) {
    senderJid = ehGrupo ? semLid(key.participantPn, key.participant) : chatJid
  }

  return {
    waId: key.id,
    chatJid,
    chatKind: ehGrupo ? 'group' : 'dm',
    senderJid,
    senderName: msg.pushName ?? null,
    fromMe,
    ts: instante(msg.messageTimestamp),
    kind: corpo.kind,
    body: corpo.body,
    quotedWaId: corpo.contextInfo?.stanzaId ?? null,
  }
}

export function createCapture({ db, now = () => Math.floor(Date.now() / 1000) }) {
  // The chat row has to exist for the foreign key; the name only arrives with
  // the group metadata, later, so inserting must never blank out what we know.
  const upsertChat = db.prepare(`
    INSERT INTO chats (jid, name, kind, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      updated_at = excluded.updated_at
  `)

  const inserirMsg = db.prepare(`
    INSERT OR IGNORE INTO messages
      (wa_id, chat_jid, sender_jid, sender_name, from_me, ts, kind, body, quoted_wa_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  return {
    rememberChat({ jid, name, kind }) {
      if (!jid) return
      upsertChat.run(jid, name ?? null, kind ?? (jid.endsWith('@g.us') ? 'group' : 'dm'), now())
    },

    record(msg) {
      const r = normalize(msg)
      if (!r) return false

      upsertChat.run(r.chatJid, null, r.chatKind, now())
      const { changes } = inserirMsg.run(
        r.waId, r.chatJid, r.senderJid, r.senderName, r.fromMe, r.ts, r.kind, r.body, r.quotedWaId,
      )
      return changes > 0
    },
  }
}
