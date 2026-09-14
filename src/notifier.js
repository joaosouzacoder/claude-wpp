import { formatNotification } from './notifyRules.js'
import { chunkText } from './text.js'

// The line agent-deck asks a finished worker to print. Its presence in the last
// reply is the one unambiguous "I am done" a session gives.
const SENTINELA = /^===AGENTDECK_DONE===\s+status=(ok|fail)\s+summary=(.*)$/m
// The conductor template answers every heartbeat with a `[STATUS]` block in
// which only the `NEED:` lines are meant for a human.
const STATUS = /^\s*\[STATUS\]/
const NEED = /^\s*NEED:\s*(.+)$/gim

// Matter the conductor has for you that names no session it watches.
const SEM_SESSAO = '*'

function escapar(texto) {
  return texto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// A heartbeat restates what is still pending in new words every time, so the
// text is no identity. What stays put is who it is about: the sessions a NEED
// line names, and how far each of them has gone. A named session that has not
// moved since you were told is the same wait; one that ran or got input since
// is a new matter. A line naming no session is one pending item until the
// heartbeats stop listing it or you talk to the conductor.
function pendencias(needs, lista, conductorTitle) {
  const filhos = lista.filter((s) => s.title !== conductorTitle)
  return needs.map((linha) => {
    const citadas = filhos.filter((s) => new RegExp(`(?<![\\w-])${escapar(s.title)}(?![\\w-])`, 'i').test(linha))
    const chaves = citadas.length ? citadas.map((s) => `${s.title}@${s.lastActivityAt ?? ''}`) : [SEM_SESSAO]
    return { linha, chaves }
  })
}

// Watches the deck and tells you when a session produced something you did not
// ask for through WhatsApp. The trigger is a new final reply, not a status flip:
// a quick turn can start and end between two polls, and `running` also covers a
// background shell that outlived its turn.
export function createNotifier({ deck, sessions, notify, maxChars, memoria, rules = formatNotification, intervalMs = 5000, log }) {
  // id -> { status, lastActivityAt, replyTs }
  let visto = null
  // conductor title -> pending-item keys you were already told about. On disk:
  // the first heartbeat after a restart would otherwise be news all over again.
  const avisadas = new Map(Object.entries(memoria?.load() ?? {}).map(([k, v]) => [k, new Set(v)]))
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

  function lembrar(conductorTitle, chaves) {
    const antes = avisadas.get(conductorTitle)
    const iguais = antes ? antes.size === chaves.size && [...chaves].every((k) => antes.has(k)) : chaves.size === 0
    if (iguais) return
    if (chaves.size) avisadas.set(conductorTitle, chaves)
    else avisadas.delete(conductorTitle)
    memoria?.save(Object.fromEntries([...avisadas].map(([k, v]) => [k, [...v]])))
  }

  // Tells only the lines carrying something you have not been told yet.
  // What is listed now replaces what was listed before, so an item that
  // dropped off the heartbeat and comes back later is news again.
  function classificar(conteudo, s, lista) {
    const casou = conteudo.match(SENTINELA)
    if (casou) return { kind: 'done', doneStatus: casou[1], summary: casou[2].trim() }
    if (!STATUS.test(conteudo)) return { kind: 'waiting', content: conteudo }

    const itens = pendencias([...conteudo.matchAll(NEED)].map((m) => m[1].trim()), lista, s.title)
    const jaAvisadas = avisadas.get(s.title) ?? new Set()
    const novas = itens.filter((i) => i.chaves.some((k) => !jaAvisadas.has(k)))
    lembrar(s.title, new Set(itens.flatMap((i) => i.chaves)))
    return novas.length ? { kind: 'status', needs: novas.map((i) => i.linha) } : null
  }

  async function enviar(ev) {
    const texto = rules(ev)
    if (!texto) return
    for (const pedaco of chunkText(texto, maxChars)) await notify(pedaco)
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
      // Talking to a conductor also answers what it had pending for you.
      if (sessions.get(s.title)?.busy) {
        lembrar(s.title, new Set())
        continue
      }

      if (s.status === 'error' && antes.status !== 'error') {
        await enviar(evento(s, lista, { kind: 'error' }))
      }

      const mexeu = s.lastActivityAt !== antes.lastActivityAt || s.status !== antes.status
      if (s.status === 'waiting' && mexeu) {
        const r = await deck.lastReply(s.title).catch(() => null)
        const ts = r?.timestamp ?? null
        const novo = ts && ts !== antes.replyTs && ts !== deck.delivered.get(s.title)
        const ev = novo ? classificar(r.content, s, lista) : null
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
