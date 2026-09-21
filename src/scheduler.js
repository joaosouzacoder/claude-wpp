// Drains the approved queue. Everything it sends was written and approved by
// the authorized number beforehand — a conditional job only gets a vote on
// *whether* to send, never on *what* to send.

import { quando, comoQuem, textoDe } from './wpp.js'

const UMA_HORA = 3600

function comoChamar(job) {
  return job.chat_name || job.chat_jid.split('@')[0]
}

export function createScheduler({
  outbox,
  send,
  decide,
  notify,
  now = () => Math.floor(Date.now() / 1000),
  toleranceSec = UMA_HORA,
  timezone = null,
  intervalMs = 30000,
  log = console,
}) {
  let timer = null
  let rodando = false

  const avisar = (texto) => Promise.resolve(notify?.(texto)).catch((e) => log.error?.(e.message ?? e))

  async function atrasado(job, agora) {
    const minutos = Math.round((agora - job.scheduled_for) / 60)
    outbox.reopen(job.id, `atrasado ${minutos}min`)
    await avisar(
      `[wpp] #${job.id} estava marcada para ${quando(job.scheduled_for, timezone)} e atrasou ${minutos}min — não mandei fora de hora.\n` +
      `Para ${comoChamar(job)}: "${job.body}"\n/ok ${job.id} manda agora, /no ${job.id} descarta.`,
    )
  }

  // A check that cannot run must never become a blind send: park the job and
  // hand the decision back to the human.
  async function verificar(job) {
    let veredito
    try {
      veredito = await decide(job)
    } catch (err) {
      outbox.reopen(job.id, `verificação falhou: ${err.message}`)
      await avisar(
        `[wpp] não consegui verificar #${job.id} antes de mandar: ${err.message}\n` +
        `Para ${comoChamar(job)}: "${job.body}"\n/ok ${job.id} manda assim mesmo, /no ${job.id} descarta.`,
      )
      return false
    }

    if (!veredito?.send) {
      const motivo = veredito?.reason ?? 'sem motivo informado'
      outbox.markSkipped(job.id, motivo)
      await avisar(`[wpp] não mandei #${job.id} para ${comoChamar(job)}: ${motivo}`)
      return false
    }
    return true
  }

  // send() is a real, non-idempotent WhatsApp call — it cannot be undone by
  // retrying, and nothing here may relabel a job as failed once it has run.
  // Marking `sending` first means a crash between the real send and the
  // write-back leaves a row a restart can flag for a human instead of one
  // that still reads `approved` and looks safe to send again.
  async function despachar(job) {
    if (!outbox.markSending(job.id)) return // /no or /edit raced us; not ours to send anymore

    const { ok, waId, error } = await send(job)
    if (!ok) {
      if (!outbox.markFailed(job.id, error ?? 'erro sem descrição', 'sending')) {
        await avisar(`[wpp] #${job.id} falhou ao mandar, mas o registro mudou de estado antes que eu conseguisse gravar isso — confira com /schedulers.`)
        return
      }
      await avisar(`[wpp] falhei ao mandar #${job.id} para ${comoChamar(job)}: ${error ?? 'erro sem descrição'}`)
      return
    }

    try {
      if (!outbox.markSent(job.id, waId, 'sending')) {
        await avisar(`[wpp] mandei #${job.id} para ${comoChamar(job)}, mas não consegui marcar como enviada (o registro mudou de estado) — a mensagem SAIU, não manda de novo.`)
        return
      }
    } catch (err) {
      log.error?.(`#${job.id} foi enviada mas não consegui gravar isso: ${err.stack ?? err.message}`)
      await avisar(`[wpp] mandei #${job.id} para ${comoChamar(job)}, mas não consegui salvar isso no banco (${err.message}) — a mensagem SAIU, não manda de novo.`)
      return
    }
    const oque = job.attachment_name ? `📎 ${job.attachment_name}` : `"${textoDe(job)}"`
    await avisar(`[wpp] mandei ${comoQuem(job)} para ${comoChamar(job)}: ${oque}\n/undo desfaz.`)
  }

  // A `sending` row left behind means the process died between the real send
  // and recording it — there is no way to know from here whether the message
  // went out. Never guess: park it and ask.
  async function reconciliarPendentes() {
    for (const job of outbox.stuckSending()) {
      outbox.reopen(job.id, 'reinício no meio do envio — confirme se chegou antes de aprovar de novo', 'sending')
      await avisar(
        `[wpp] #${job.id} estava sendo enviada quando eu reiniciei e não sei se chegou — confira a conversa com ${comoChamar(job)} antes de decidir.\n` +
        `"${job.body}"\n/ok ${job.id} manda (de novo, se ainda não chegou) · /no ${job.id} descarta`,
      )
    }
  }

  async function tick() {
    if (rodando) return
    rodando = true
    try {
      const agora = now()
      for (const job of outbox.due(agora)) {
        try {
          if (job.scheduled_for != null && agora - job.scheduled_for > toleranceSec) {
            await atrasado(job, agora)
            continue
          }
          if (job.kind === 'conditional' && !(await verificar(job))) continue
          await despachar(job)
        } catch (err) {
          // despachar() may have already moved this row to `sending` before
          // throwing (e.g. send() itself threw instead of resolving
          // {ok:false}). Try that state first so the guarded write still
          // lands; falling back to `approved` covers a throw from earlier
          // (verificar/atrasado). If neither matches, something external
          // already decided this job's fate — leave it alone.
          if (!outbox.markFailed(job.id, err.message ?? String(err), 'sending')) {
            outbox.markFailed(job.id, err.message ?? String(err), 'approved')
          }
          log.error?.(`falha no job ${job.id}: ${err.stack ?? err.message}`)
        }
      }
    } finally {
      rodando = false
    }
  }

  return {
    tick,
    start() {
      const primeira = !timer
      timer ??= setInterval(() => { tick().catch((e) => log.error?.(e.message ?? e)) }, intervalMs)
      timer.unref?.()
      if (primeira) reconciliarPendentes().catch((e) => log.error?.(e.message ?? e))
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
  }
}
