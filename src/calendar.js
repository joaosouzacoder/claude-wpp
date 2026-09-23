// The owner's work calendar, for the assistant to read and change.
//
// The access token comes from `ortie`, which already holds the OAuth grant for
// the corporate account on this host and refreshes it on its own. Nothing here
// stores a credential; it asks for a fresh token per call and never logs it.

const API = 'https://www.googleapis.com/calendar/v3'
const TIMEOUT_MS = 30000

// Wall-clock helpers. Everything the owner says ("amanhã 14h") is wall time in
// his timezone; everything the API speaks is an instant. These two functions
// are the only bridge, so a mistake here is a meeting at the wrong hour.
export function partesLocais(tz, epochSec) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochSec * 1000))
    .filter((x) => x.type !== 'literal')
  const o = Object.fromEntries(p.map((x) => [x.type, Number(x.value)]))
  return { ano: o.year, mes: o.month, dia: o.day, hora: o.hour % 24, minuto: o.minute, segundo: o.second }
}

// Two passes: the offset depends on the instant, so a single pass lands an
// hour off on the days a timezone changes.
export function instanteLocal({ ano, mes, dia, hora = 0, minuto = 0 }, tz) {
  const ingenuo = Date.UTC(ano, mes - 1, dia, hora, minuto) / 1000
  const desloca = (epoch) => {
    const l = partesLocais(tz, epoch)
    return Date.UTC(l.ano, l.mes - 1, l.dia, l.hora, l.minuto, l.segundo) / 1000 - epoch
  }
  const primeiro = ingenuo - desloca(ingenuo)
  return ingenuo - desloca(primeiro)
}

const DIAS = { hoje: 0, amanha: 1, amanhã: 1, depois: 2, ontem: -1 }

// "hoje", "amanhã", "2026-09-24", and any of those with "14:00" after it.
export function quandoEm(texto, tz, agora) {
  const bruto = String(texto ?? '').trim().toLowerCase()
  if (!bruto) throw new Error('faltou a data')

  const [parteDia, parteHora] = bruto.split(/\s+/)
  const hoje = partesLocais(tz, agora)

  let base
  if (parteDia in DIAS) {
    base = { ano: hoje.ano, mes: hoje.mes, dia: hoje.dia + DIAS[parteDia] }
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parteDia)
    if (!m) throw new Error(`não entendi a data "${texto}" — use AAAA-MM-DD, "hoje" ou "amanhã"`)
    base = { ano: Number(m[1]), mes: Number(m[2]), dia: Number(m[3]) }
    // Date.UTC "fixes" a month 13 into next January and a 31st of February
    // into March. A calendar that quietly moves an appointment to another
    // month is worse than one that says it did not understand.
    const conferir = new Date(Date.UTC(base.ano, base.mes - 1, base.dia))
    if (conferir.getUTCMonth() + 1 !== base.mes || conferir.getUTCDate() !== base.dia) {
      throw new Error(`não entendi a data "${parteDia}" — esse dia não existe`)
    }
  }

  if (!parteHora) return { inicio: instanteLocal(base, tz), diaInteiro: true }

  const h = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(parteHora)
  if (!h) throw new Error(`não entendi a hora "${parteHora}" — use HH:MM`)
  return { inicio: instanteLocal({ ...base, hora: Number(h[1]), minuto: Number(h[2]) }, tz), diaInteiro: false }
}

// The whole of that day, in his timezone.
export function janelaDoDia(texto, tz, agora) {
  const { inicio } = quandoEm(texto, tz, agora)
  const d = partesLocais(tz, inicio)
  return {
    de: instanteLocal({ ano: d.ano, mes: d.mes, dia: d.dia }, tz),
    ate: instanteLocal({ ano: d.ano, mes: d.mes, dia: d.dia + 1 }, tz),
  }
}

export const paraIso = (epochSec) => new Date(epochSec * 1000).toISOString()

export function horaLocal(epochSec, tz) {
  const p = partesLocais(tz, epochSec)
  return `${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`
}

export function dataLocal(epochSec, tz) {
  const p = partesLocais(tz, epochSec)
  return `${String(p.dia).padStart(2, '0')}/${String(p.mes).padStart(2, '0')}`
}

// An event as the API returns it, reduced to what he needs to hear.
export function resumirEvento(ev, tz) {
  const inicio = ev.start?.dateTime ? Math.floor(new Date(ev.start.dateTime).getTime() / 1000) : null
  const fim = ev.end?.dateTime ? Math.floor(new Date(ev.end.dateTime).getTime() / 1000) : null
  const quando = inicio === null
    ? 'dia inteiro'
    : `${horaLocal(inicio, tz)}${fim ? `-${horaLocal(fim, tz)}` : ''}`
  const convidados = (ev.attendees ?? []).filter((a) => !a.self).map((a) => a.email)
  return {
    id: ev.id,
    quando,
    dia: inicio === null ? (ev.start?.date ?? '') : dataLocal(inicio, tz),
    titulo: ev.summary ?? '(sem título)',
    onde: ev.location ?? ev.hangoutLink ?? null,
    convidados,
    inicio,
    fim,
    minhaResposta: (ev.attendees ?? []).find((a) => a.self)?.responseStatus ?? null,
  }
}

// The gaps between events inside a window. Used for "tenho horário livre
// sexta de manhã?" — overlapping and back-to-back meetings collapse, so the
// answer is the real free time and not a slice of a busy block.
export function horariosLivres({ de, ate, eventos, minimoMin = 30 }) {
  const ocupados = eventos
    .filter((e) => e.inicio !== null && e.fim !== null)
    .map((e) => ({ de: Math.max(e.inicio, de), ate: Math.min(e.fim, ate) }))
    .filter((e) => e.ate > e.de)
    .sort((a, b) => a.de - b.de)

  const mesclados = []
  for (const bloco of ocupados) {
    const ultimo = mesclados.at(-1)
    if (ultimo && bloco.de <= ultimo.ate) ultimo.ate = Math.max(ultimo.ate, bloco.ate)
    else mesclados.push({ ...bloco })
  }

  const livres = []
  let cursor = de
  for (const bloco of mesclados) {
    if (bloco.de - cursor >= minimoMin * 60) livres.push({ de: cursor, ate: bloco.de })
    cursor = Math.max(cursor, bloco.ate)
  }
  if (ate - cursor >= minimoMin * 60) livres.push({ de: cursor, ate })
  return livres
}

export function createCalendar({ token, calendarId = 'primary', timezone = 'America/Sao_Paulo', fetchImpl = fetch }) {
  async function chamar(caminho, { metodo = 'GET', corpo = null, query = {} } = {}) {
    const url = new URL(`${API}/calendars/${encodeURIComponent(calendarId)}${caminho}`)
    for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, String(v))

    const acesso = await token()
    const r = await fetchImpl(url, {
      method: metodo,
      headers: { authorization: `Bearer ${acesso}`, 'content-type': 'application/json' },
      ...(corpo ? { body: JSON.stringify(corpo) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (r.status === 204) return null
    const json = await r.json().catch(() => null)
    if (!r.ok) {
      // The token is never in the message: this text ends up on WhatsApp.
      const motivo = json?.error?.message ?? `o Google respondeu ${r.status}`
      throw new Error(r.status === 401 || r.status === 403 ? `sem acesso à agenda (${motivo})` : motivo)
    }
    return json
  }

  return {
    async listar({ de, ate, busca = null, max = 50 }) {
      const r = await chamar('/events', {
        query: {
          timeMin: paraIso(de), timeMax: paraIso(ate),
          singleEvents: 'true', orderBy: 'startTime', maxResults: max,
          q: busca, timeZone: timezone,
        },
      })
      return (r?.items ?? []).map((ev) => resumirEvento(ev, timezone))
    },

    async criar({ titulo, inicio, duracaoMin = 30, onde = null, convidados = [], descricao = null }) {
      const corpo = {
        summary: titulo,
        start: { dateTime: paraIso(inicio), timeZone: timezone },
        end: { dateTime: paraIso(inicio + duracaoMin * 60), timeZone: timezone },
        ...(onde ? { location: onde } : {}),
        ...(descricao ? { description: descricao } : {}),
        ...(convidados.length ? { attendees: convidados.map((email) => ({ email })) } : {}),
      }
      const r = await chamar('/events', { metodo: 'POST', corpo, query: { sendUpdates: convidados.length ? 'all' : 'none' } })
      return resumirEvento(r, timezone)
    },

    async mover({ id, inicio, duracaoMin = null }) {
      const atual = resumirEvento(await chamar(`/events/${encodeURIComponent(id)}`), timezone)
      const duracao = duracaoMin ?? (atual.inicio && atual.fim ? Math.round((atual.fim - atual.inicio) / 60) : 30)
      const r = await chamar(`/events/${encodeURIComponent(id)}`, {
        metodo: 'PATCH',
        corpo: {
          start: { dateTime: paraIso(inicio), timeZone: timezone },
          end: { dateTime: paraIso(inicio + duracao * 60), timeZone: timezone },
        },
        query: { sendUpdates: atual.convidados.length ? 'all' : 'none' },
      })
      return { antes: atual, depois: resumirEvento(r, timezone) }
    },

    // What was deleted comes back, so it can be recreated if it was the wrong
    // one: on a calendar there is no undo.
    async apagar({ id }) {
      const atual = resumirEvento(await chamar(`/events/${encodeURIComponent(id)}`), timezone)
      await chamar(`/events/${encodeURIComponent(id)}`, { metodo: 'DELETE', query: { sendUpdates: atual.convidados.length ? 'all' : 'none' } })
      return atual
    },

    async responder({ id, resposta }) {
      const mapa = { sim: 'accepted', nao: 'declined', não: 'declined', talvez: 'tentative' }
      const status = mapa[String(resposta).toLowerCase()]
      if (!status) throw new Error('resposta tem que ser sim, não ou talvez')

      const ev = await chamar(`/events/${encodeURIComponent(id)}`)
      const convidados = (ev.attendees ?? []).map((a) => (a.self ? { ...a, responseStatus: status } : a))
      if (!convidados.some((a) => a.self)) throw new Error('você não está na lista de convidados desse evento')

      const r = await chamar(`/events/${encodeURIComponent(id)}`, { metodo: 'PATCH', corpo: { attendees: convidados }, query: { sendUpdates: 'all' } })
      return resumirEvento(r, timezone)
    },
  }
}
