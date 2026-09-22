// Recurring and one-off jobs the assistant runs for him: "todo dia às 9
// confere o chamado e me conta". Before this existed the assistant improvised
// with the host's crontab — nobody could say afterwards what was scheduled,
// the shell script it wrote was the only thing that knew, and it deleted its
// own cron line on an answer it misread.
//
// A task is a sentence, not a script: at its hour the assistant is handed the
// prompt in its own session, with its own tools, and answers in the chat.

const DIARIA = /^([01]?\d|2[0-3]):([0-5]\d)$/

// The wall clock in a timezone, as the epoch seconds of that same instant.
function deslocamento(tz, epochSec) {
  const d = new Date(epochSec * 1000)
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]),
  )
  const comoUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) / 1000
  return comoUtc - epochSec
}

function dataLocal(tz, epochSec) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(epochSec * 1000))
  const [ano, mes, dia] = p.filter((x) => x.type !== 'literal').map((x) => Number(x.value))
  return { ano, mes, dia }
}

// The epoch second at which that wall time happens in that timezone. Done in
// two passes because the offset itself depends on the instant: a naive single
// pass lands an hour off on the days DST moves.
function instanteLocal({ ano, mes, dia, hora, minuto }, tz) {
  const ingenuo = Date.UTC(ano, mes - 1, dia, hora, minuto) / 1000
  const primeiro = ingenuo - deslocamento(tz, ingenuo)
  return ingenuo - deslocamento(tz, primeiro)
}

// The next time that hour comes round in his timezone, strictly after `agora`.
export function proximaDiaria(hhmm, tz, agora) {
  const m = DIARIA.exec(String(hhmm ?? '').trim())
  if (!m) throw new Error(`horário inválido: "${hhmm}" — use HH:MM, ex. 09:00`)
  const [hora, minuto] = [Number(m[1]), Number(m[2])]
  const hoje = dataLocal(tz, agora)
  for (let d = 0; d <= 2; d++) {
    const alvo = instanteLocal({ ...hoje, dia: hoje.dia + d, hora, minuto }, tz)
    if (alvo > agora) return alvo
  }
  throw new Error(`não consegui calcular o próximo ${hhmm} em ${tz}`)
}

export function createTasks({ db, timezone = 'America/Sao_Paulo', now = () => Math.floor(Date.now() / 1000) }) {
  const stmt = {
    criar: db.prepare(`INSERT INTO tasks (prompt, label, daily_at, tz, next_run, status, created_at)
                       VALUES (?, ?, ?, ?, ?, 'ativa', ?)`),
    get: db.prepare('SELECT * FROM tasks WHERE id = ?'),
    ativas: db.prepare("SELECT * FROM tasks WHERE status = 'ativa' ORDER BY next_run"),
    vencidas: db.prepare("SELECT * FROM tasks WHERE status = 'ativa' AND next_run <= ? ORDER BY next_run"),
    reagendar: db.prepare('UPDATE tasks SET next_run = ?, last_run_at = ? WHERE id = ?'),
    encerrar: db.prepare("UPDATE tasks SET status = ?, last_run_at = COALESCE(?, last_run_at) WHERE id = ? AND status = 'ativa'"),
  }

  return {
    // Either `dailyAt` ("09:00", every day at that hour) or `at` (one epoch
    // second, once). A task with neither has no moment to happen at.
    create({ prompt, label = null, dailyAt = null, at = null, tz = timezone } = {}) {
      const texto = String(prompt ?? '').trim()
      if (!texto) throw new Error('tarefa sem pedido')
      if (!dailyAt && !at) throw new Error('tarefa sem horário: passe dailyAt "HH:MM" ou at <epoch>')
      if (dailyAt && at) throw new Error('tarefa com dois horários: escolha dailyAt ou at')

      const proximo = dailyAt ? proximaDiaria(dailyAt, tz, now()) : Number(at)
      if (!Number.isFinite(proximo)) throw new Error('horário inválido')
      if (!dailyAt && proximo <= now()) throw new Error('esse horário já passou')

      const { lastInsertRowid } = stmt.criar.run(texto, label, dailyAt, tz, proximo, now())
      return stmt.get.get(lastInsertRowid)
    },

    get: (id) => stmt.get.get(id) ?? null,
    list: () => stmt.ativas.all(),
    due: (ts = now()) => stmt.vencidas.all(ts),

    // A daily task lives on to its next hour; a one-off is done once it ran.
    ranOnce(id) {
      const tarefa = stmt.get.get(id)
      if (!tarefa) return null
      if (!tarefa.daily_at) {
        stmt.encerrar.run('feita', now(), id)
        return stmt.get.get(id)
      }
      stmt.reagendar.run(proximaDiaria(tarefa.daily_at, tarefa.tz ?? timezone, now()), now(), id)
      return stmt.get.get(id)
    },

    // What the assistant calls when the thing being watched finally settled,
    // and what he calls when he wants it to stop.
    finish: (id) => (stmt.encerrar.run('feita', null, id).changes > 0 ? stmt.get.get(id) : null),
    cancel: (id) => (stmt.encerrar.run('cancelada', null, id).changes > 0 ? stmt.get.get(id) : null),
  }
}
