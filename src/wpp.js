import { readFileSync } from 'node:fs'
import { citacaoDe } from './whatsapp.js'

const CONTEXTO_MAX = 60

// The host may well run in UTC while the person reading this thinks in their own
// zone. Showing the machine's hour would make him reject a draft that was right.
export function quando(ts, timezone) {
  return new Date(ts * 1000).toLocaleString('pt-BR', {
    dateStyle: 'short', timeStyle: 'short', ...(timezone ? { timeZone: timezone } : {}),
  })
}

function nomeDo(job) {
  return job.chat_name || job.chat_jid.split('@')[0]
}

// The verifier answers in one line. Anything else is a refusal to decide, and a
// refusal must never be read as permission — the caller turns this into a
// question for the human.
//
// The verdict word must open its own line — not just appear anywhere with a
// word boundary. Without that anchor, a stray mention earlier in the text
// (e.g. "vou pular esse detalhe, mas ENVIAR mesmo assim") would be misread as
// the verdict instead of the one actually meant.
export function parseVeredito(texto) {
  const casou = String(texto ?? '').match(/^\s*(enviar|pular)\b\s*[:\-—]?\s*(.*)/im)
  if (!casou) throw new Error(`não entendi o veredito da verificação: ${String(texto ?? '').slice(0, 200)}`)
  return {
    send: casou[1].toLowerCase() === 'enviar',
    reason: casou[2].trim() || 'sem motivo informado',
  }
}

export function comoQuem(job) {
  return job.sender === 'bot' ? 'pelo bot' : 'como você'
}

// The words that actually go out: through the bot, the formal version.
export function textoDe(job) {
  return job.sender === 'bot' ? (job.body_bot ?? job.body) : job.body
}

function conteudoDo(job) {
  const anexo = job.attachment_name ? `📎 ${job.attachment_name}` : null
  const texto = textoDe(job)
  if (anexo && !texto) return anexo
  return anexo ? `${anexo} — "${texto}"` : `"${texto}"`
}

export function formatDraft(job, timezone) {
  const linhas = [`[wpp] rascunho #${job.id} → ${nomeDo(job)}`]
  if (job.scheduled_for) linhas.push(`sai em ${quando(job.scheduled_for, timezone)}`)
  if (job.kind === 'conditional') linhas.push(`antes de mandar, verifica: ${job.check_prompt}`)
  if (job.attachment_name) linhas.push(`📎 ${job.attachment_name}`)
  const aspas = (t) => (t ? `"${t}"` : '(sem texto)')
  if (job.body_bot) {
    linhas.push('', `/ok ${job.id} — como você:`, aspas(job.body), '', `/bot ${job.id} — pelo bot:`, aspas(job.body_bot))
  } else {
    linhas.push('', aspas(job.body), '', `/ok ${job.id} manda como você · /bot ${job.id} formaliza e manda pelo bot`)
  }
  linhas.push('', `/no ${job.id} descarta`)
  return linhas.join('\n')
}

// A draft that went out without asking still gets reported: the owner learns
// what was said in his name, and how to take it back.
export function formatDirect(job, timezone) {
  const linhas = [`[wpp] 📤 #${job.id} ${comoQuem(job)} → ${nomeDo(job)}`]
  if (job.scheduled_for) linhas.push(`sai em ${quando(job.scheduled_for, timezone)}`)
  linhas.push('', conteudoDo(job), '', job.scheduled_for ? `/no ${job.id} cancela` : '/undo apaga')
  return linhas.join('\n')
}

export function formatQueue({ pending, scheduled }, timezone) {
  if (!pending.length && !scheduled.length) return '[wpp] nada pendente e nada agendado.'

  const linha = (j) => {
    const marca = j.kind === 'conditional' ? ' (verifica antes)' : ''
    const hora = j.scheduled_for ? `${quando(j.scheduled_for, timezone)} · ` : ''
    return `#${j.id} ${hora}${nomeDo(j)}${marca}: ${conteudoDo(j)}`
  }

  const partes = []
  if (pending.length) partes.push('Esperando seu ok:', ...pending.map(linha))
  if (scheduled.length) partes.push(...(partes.length ? [''] : []), 'Agendadas:', ...scheduled.map(linha))
  return partes.join('\n')
}

// `wa` is the owner's own account; `bot` the bot's, for drafts approved with
// /bot instead of /ok.
export function createWpp({ db, outbox, wa, bot = null, run, config, now = () => Math.floor(Date.now() / 1000) }) {
  const contaDe = (job) => {
    if (job.sender !== 'bot') return wa
    if (!bot) throw new Error('conta do bot indisponível para este envio')
    return bot
  }

  const tz = config.timezone
  const buscarCitada = db.prepare('SELECT * FROM messages WHERE chat_jid = ? AND wa_id = ?')
  const conversaDesde = db.prepare(`
    SELECT sender_name, from_me, ts, body FROM messages
    WHERE chat_jid = ? AND ts >= ? ORDER BY ts LIMIT ?
  `)

  async function send(job) {
    try {
      const conta = contaDe(job)
      if (job.attachment_path) {
        const waId = await conta.sendDocument(job.chat_jid, {
          content: readFileSync(job.attachment_path),
          fileName: job.attachment_name,
          caption: textoDe(job) || undefined,
          mimetype: job.attachment_mimetype ?? 'application/octet-stream',
        })
        return { ok: true, waId }
      }
      // A quote points at a message in the owner's own history, which the
      // bot's account cannot reference.
      const citada = job.quoted_wa_id && job.sender !== 'bot' ? buscarCitada.get(job.chat_jid, job.quoted_wa_id) : null
      const waId = await conta.sendText(job.chat_jid, textoDe(job), { quoted: citacaoDe(citada) })
      return { ok: true, waId }
    } catch (err) {
      return { ok: false, error: err.message ?? String(err) }
    }
  }

  async function undo() {
    const job = outbox.lastSent()
    if (!job) return { ok: false, error: 'não tem nada recente para desfazer.' }

    try {
      // Only the account that sent a message can delete it for everyone.
      await contaDe(job).deleteMessage(job.chat_jid, job.sent_wa_id)
    } catch (err) {
      return { ok: false, error: err.message ?? String(err) }
    }

    outbox.markDeleted(job.id)
    return { ok: true, job }
  }

  // Reads only the conversation this job is aimed at, only from the moment it
  // was scheduled. The verifier votes on whether to send; the text it would send
  // was already approved and is not up for rewriting here.
  async function decide(job) {
    const desde = job.created_at ?? 0
    const conversa = conversaDesde.all(job.chat_jid, desde, CONTEXTO_MAX)
      .map((m) => `${m.from_me ? 'eu' : (m.sender_name ?? 'ele/ela')} (${quando(m.ts, tz)}): ${m.body}`)
      .join('\n')

    const prompt = [
      'Você é um verificador. Responda em UMA linha, exatamente num destes formatos:',
      'ENVIAR: <motivo curto>',
      'PULAR: <motivo curto>',
      '',
      `Mensagem já aprovada, pronta para ser enviada agora para ${nomeDo(job)}:`,
      `"${job.body}"`,
      '',
      `Verifique antes de mandar: ${job.check_prompt}`,
      '',
      `Conversa com ${nomeDo(job)} desde que isso foi agendado (${quando(desde, tz)}):`,
      conversa || '(nenhuma mensagem nova nessa conversa desde então)',
      '',
      'Se a conversa não responder claramente à verificação, responda ENVIAR.',
      'Não escreva mais nada além da linha do veredito.',
    ].join('\n')

    const r = await run({
      bin: config.claudeBin,
      cwd: config.agentCwd,
      prompt,
      timeoutMs: config.timeoutMs,
    })
    if (!r.ok) throw new Error(r.error ?? 'a verificação falhou sem descrição')
    return parseVeredito(r.text)
  }

  return { send, undo, decide, now, timezone: tz }
}
