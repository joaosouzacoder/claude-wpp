// Drains the approved queue. Everything it sends was written and approved by
// the authorized number beforehand — a conditional job only gets a vote on
// *whether* to send, never on *what* to send.

const UMA_HORA = 3600

function quando(ts) {
  return new Date(ts * 1000).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

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
      `[wpp] #${job.id} estava marcada para ${quando(job.scheduled_for)} e atrasou ${minutos}min — não mandei fora de hora.\n` +
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

  async function despachar(job) {
    const { ok, waId, error } = await send(job)
    if (!ok) {
      outbox.markFailed(job.id, error ?? 'erro sem descrição')
      await avisar(`[wpp] falhei ao mandar #${job.id} para ${comoChamar(job)}: ${error ?? 'erro sem descrição'}`)
      return
    }
    outbox.markSent(job.id, waId)
    await avisar(`[wpp] mandei para ${comoChamar(job)}: "${job.body}"\n/undo desfaz.`)
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
          outbox.markFailed(job.id, err.message ?? String(err))
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
      timer ??= setInterval(() => { tick().catch((e) => log.error?.(e.message ?? e)) }, intervalMs)
      timer.unref?.()
    },
    stop() {
      clearInterval(timer)
      timer = null
    },
  }
}
