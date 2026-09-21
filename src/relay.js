import { normalizeNumber, sameNumber, senderNumber } from './numbers.js'

// Replies to the bot, passed on to the owner, and his answers passed back.
//
// Only people the bot has written to are relayed; anyone else writing to the
// bot stays ignored. Nothing on this path reaches Claude as a request: a
// third party's text is only ever shown to the owner, and the owner's answer
// is only ever rewritten (formally) and sent — never executed.

const RETENCAO_S = 30 * 24 * 60 * 60

function descreverMidia(kind) {
  return {
    image: '(mandou uma imagem)',
    audio: '(mandou um áudio)',
    document: '(mandou um arquivo)',
  }[kind] ?? '(mandou algo que não é texto)'
}

// What the formalizer must answer with: the message and nothing else.
export function promptFormal({ nome, recebida, resposta }) {
  return [
    'Reescreva a resposta abaixo em português formal e cordial, como uma mensagem de WhatsApp',
    'enviada em nome do João por um assistente. Mantenha exatamente o conteúdo, os fatos e os',
    'compromissos — não acrescente nem retire informação, não invente saudações longas.',
    'Responda SOMENTE com o texto final da mensagem, sem aspas e sem comentários.',
    '',
    `Mensagem que ${nome ?? 'a pessoa'} mandou:`,
    recebida ? `"${recebida}"` : '(não disponível)',
    '',
    'Resposta do João, a reescrever:',
    `"${resposta}"`,
  ].join('\n')
}

// A model sometimes wraps the answer in quotes anyway.
export function limparFormal(texto) {
  return String(texto ?? '').trim().replace(/^["“](.*)["”]$/s, '$1').trim()
}

export function createRelay({ db, ownerNumber, notifyOwner, sendAsBot, formalize, now = () => Math.floor(Date.now() / 1000), log = console }) {
  const stmt = {
    lembrar: db.prepare(`
      INSERT INTO bot_contacts (number, name, last_sent_at) VALUES (?, ?, ?)
      ON CONFLICT(number) DO UPDATE SET last_sent_at = excluded.last_sent_at, name = COALESCE(excluded.name, bot_contacts.name)
    `),
    contatos: db.prepare('SELECT number, name FROM bot_contacts'),
    nomeDoChat: db.prepare('SELECT name FROM chats WHERE jid = ?'),
    registrar: db.prepare('INSERT INTO relay (owner_wa_id, from_number, from_name, body, received_at) VALUES (?, ?, ?, ?, ?)'),
    porWaId: db.prepare('SELECT * FROM relay WHERE owner_wa_id = ?'),
    porId: db.prepare('SELECT * FROM relay WHERE id = ?'),
    vincular: db.prepare('UPDATE relay SET owner_wa_id = ? WHERE id = ?'),
    podar: db.prepare('DELETE FROM relay WHERE received_at < ?'),
  }

  // Called for every message the bot sends. The owner himself and groups are
  // not "someone the bot wrote to".
  function noteSent(destino) {
    const texto = String(destino ?? '')
    if (texto.endsWith('@g.us') || texto.includes('@lid')) return
    const numero = normalizeNumber(texto)
    if (!numero || sameNumber(numero, ownerNumber)) return
    const nome = stmt.nomeDoChat.get(`${numero}@s.whatsapp.net`)?.name ?? null
    stmt.lembrar.run(numero, nome, now())
  }

  function contatoConhecido(numero) {
    return stmt.contatos.all().find((c) => sameNumber(c.number, numero)) ?? null
  }

  // A message from someone other than the owner reached the bot.
  async function onOther({ key, kind, text, pushName }) {
    if (String(key?.remoteJid ?? '').endsWith('@g.us')) return
    const numero = senderNumber(key)
    if (!numero) return
    const contato = contatoConhecido(numero)
    if (!contato) {
      log.info?.('[relay] mensagem de quem o bot nunca escreveu; ignorada.')
      return
    }

    const nome = contato.name ?? pushName ?? numero
    const corpo = text || descreverMidia(kind)
    const { lastInsertRowid } = stmt.registrar.run(null, contato.number, nome, corpo, now())
    const id = Number(lastInsertRowid)
    const waId = await notifyOwner(`💬 ${nome} respondeu (#${id}):\n\n${corpo}\n\n↩️ Responda citando esta mensagem (ou /r ${id} <texto>) — eu formalizo e mando pelo bot.`)
    if (waId) stmt.vincular.run(waId, id)
    stmt.podar.run(now() - RETENCAO_S)
  }

  function porCitacao(stanzaId) {
    return stanzaId ? stmt.porWaId.get(stanzaId) ?? null : null
  }

  function porNumero(id) {
    return stmt.porId.get(id) ?? null
  }

  // The owner's answer: rewritten formally, then sent by the bot. If the
  // rewrite fails, nothing is sent — his raw words would break "always
  // formal through the bot".
  async function answer(linha, resposta) {
    let formal
    try {
      formal = limparFormal(await formalize(promptFormal({ nome: linha.from_name, recebida: linha.body, resposta })))
    } catch (err) {
      return { ok: false, error: `não consegui formalizar (${err.message}) — não mandei nada para ${linha.from_name}.` }
    }
    if (!formal) return { ok: false, error: `a versão formal veio vazia — não mandei nada para ${linha.from_name}.` }

    try {
      await sendAsBot(`${linha.from_number}@s.whatsapp.net`, formal)
    } catch (err) {
      return { ok: false, error: `falhei ao mandar para ${linha.from_name}: ${err.message}` }
    }
    return { ok: true, to: linha.from_name, text: formal }
  }

  return { noteSent, onOther, porCitacao, porNumero, answer }
}
