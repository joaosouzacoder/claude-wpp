import { formatNotification } from './notifyRules.js'

// The line agent-deck asks a finished worker to print. Its presence in the last
// reply is the one unambiguous "I am done" a session gives.
const SENTINELA = /^===AGENTDECK_DONE===\s+status=(ok|fail)\s+summary=(.*)$/m
// The conductor template answers every heartbeat with a `[STATUS]` block in
// which only the `NEED:` lines are meant for a human.
const STATUS = /^\s*\[STATUS\]/
const NEED = /^\s*NEED:\s*(.+)$/gim

// A heartbeat reply is a status report, not a question: reduce it to its NEED
// lines. Those tend to repeat unchanged for hours, so an unchanged set is not
// news either — only a different one is.
function classificar(conteudo, antes) {
  const casou = conteudo.match(SENTINELA)
  if (casou) return { kind: 'done', doneStatus: casou[1], summary: casou[2].trim() }
  if (!STATUS.test(conteudo)) return { kind: 'waiting', content: conteudo }

  const needs = [...conteudo.matchAll(NEED)].map((m) => m[1].trim())
  const chave = needs.join('\n')
  if (chave === antes.needs) return null
  antes.needs = chave
  return { kind: 'status', needs }
}

// Watches the deck and tells you when a session produced something you did not
// ask for through WhatsApp. The trigger is a new final reply, not a status flip:
// a quick turn can start and end between two polls, and `running` also covers a
// background shell that outlived its turn.
export function createNotifier({ deck, sessions, notify, rules = formatNotification, intervalMs = 5000, log }) {
  // id -> { status, lastActivityAt, replyTs }
  let visto = null
  let timer = null
  let parado = true
  let falhando = false

  async function baseline(lista) {
    const mapa = new Map()
    for (const s of lista) {
      const r = await deck.lastReply(s.title).catch(() => null)
      mapa.set(s.id, { status: s.status, lastActivityAt: s.lastActivityAt, replyTs: r?.timestamp ?? null })
    }
    return mapa
  }

  function evento(s, lista, extra) {
    const pai = s.parentId ? lista.find((p) => p.id === s.parentId) : null
    return {
      title: s.title,
      group: s.group,
      parentTitle: pai?.title ?? null,
      addressable: /^[a-z0-9_-]{1,24}$/i.test(s.title),
      ...extra,
    }
  }

  async function enviar(ev) {
    const texto = rules(ev)
    if (texto) await notify(texto)
  }

  async function tick() {
    let lista
    try {
      lista = await deck.list()
      if (falhando) log?.info('notifier: agent-deck voltou a responder.')
      falhando = false
    } catch (err) {
      // One line per outage, not one per poll.
      if (!falhando) log?.warn(`notifier: ${err.message}`)
      falhando = true
      return
    }

    // The first look only learns what is already there. Waking up to eight
    // sessions sitting in `waiting` is the state of things, not news.
    if (!visto) {
      visto = await baseline(lista)
      return
    }

    for (const s of lista) {
      const antes = visto.get(s.id)
      if (!antes) {
        const r = await deck.lastReply(s.title).catch(() => null)
        visto.set(s.id, { status: s.status, lastActivityAt: s.lastActivityAt, replyTs: r?.timestamp ?? null })
        continue
      }

      // A conversation from WhatsApp owns this turn; its reply is on the way.
      if (sessions.get(s.title)?.busy) continue

      if (s.status === 'error' && antes.status !== 'error') {
        await enviar(evento(s, lista, { kind: 'error' }))
      }

      const mexeu = s.lastActivityAt !== antes.lastActivityAt || s.status !== antes.status
      if (s.status === 'waiting' && mexeu) {
        const r = await deck.lastReply(s.title).catch(() => null)
        const ts = r?.timestamp ?? null
        const novo = ts && ts !== antes.replyTs && ts !== deck.delivered.get(s.title)
        const ev = novo ? classificar(r.content, antes) : null
        if (ev) await enviar(evento(s, lista, ev))
        if (ts) antes.replyTs = ts
      }

      antes.status = s.status
      antes.lastActivityAt = s.lastActivityAt
    }
  }

  function agendar() {
    if (parado) return
    timer = setTimeout(async () => {
      try {
        await tick()
      } catch (err) {
        // The bot is the half that must never go down; a notifier bug is not a
        // reason to take it with it.
        log?.error(`notifier: ${err.stack ?? err.message}`)
      }
      agendar()
    }, intervalMs)
  }

  return {
    tick,
    start() {
      if (!parado) return
      parado = false
      agendar()
    },
    stop() {
      parado = true
      clearTimeout(timer)
    },
  }
}
