import { homedir } from 'node:os'
import { expandir } from './sessions.js'

const NOME_VALIDO = /^[a-z0-9_-]{1,24}$/i
// Where a plain message lands when no session is active — the deck's
// counterpart of the headless mode's auto-created `s1`.
const SESSAO_PADRAO = 'home'
// Sessions opened from WhatsApp live apart from the conductors in the deck.
const GRUPO = 'whatsapp'
// Same split as sessions.js: only what you asked for survives a restart.
const PERSISTIDO = ['name', 'pending', 'queue']

// Same shape as createSessions, so handler.js does not care which one it got.
// The deck owns which sessions exist; this only adds what the deck cannot know:
// which one is active here, and the requests still owed an answer.
export function createDeckSessions({ deck, store, defaultCwd = homedir(), now = () => new Date().toISOString() }) {
  const salvo = store.load()
  const porNome = new Map()

  // Requests owed across a restart, kept even for a session the deck no longer
  // lists: dropping them would lose work in silence.
  for (const s of salvo.sessions) {
    if (!s.pending && !s.queue?.length) continue
    porNome.set(s.name, novo(s.name, { pending: s.pending ?? null, queue: Array.isArray(s.queue) ? s.queue : [] }))
  }
  let activeSession = salvo.activeSession ?? null

  function novo(name, extra = {}) {
    return {
      name,
      cwd: null,
      id: null,
      status: null,
      group: null,
      parentId: null,
      lastActivityAt: now(),
      claudeSessionId: null,
      addressable: NOME_VALIDO.test(name),
      pending: null,
      queue: [],
      busy: false,
      abort: null,
      ...extra,
    }
  }

  function persist() {
    store.save({
      sessions: [...porNome.values()]
        .filter((s) => s.pending || s.queue.length)
        .map((s) => Object.fromEntries(PERSISTIDO.map((k) => [k, s[k]]))),
      activeSession,
    })
  }

  function ordenar(lista) {
    // Children right under their parent, so /ls reads like the deck's tree.
    const raizes = lista.filter((s) => !s.parentId || !lista.some((p) => p.id === s.parentId))
    return raizes.flatMap((r) => [r, ...lista.filter((s) => s.parentId === r.id)])
  }

  const api = {
    kind: 'deck',

    // Objects keep their identity across refreshes: the handler holds one while
    // a run is in flight and flips `busy` on it.
    async refresh() {
      const lista = await deck.list()
      const vistos = new Set()
      for (const d of lista) {
        vistos.add(d.title)
        const s = porNome.get(d.title) ?? novo(d.title)
        Object.assign(s, {
          cwd: d.path,
          id: d.id,
          status: d.status,
          group: d.group,
          parentId: d.parentId,
          lastActivityAt: d.lastActivityAt ?? s.lastActivityAt,
        })
        porNome.set(d.title, s)
      }
      for (const [nome, s] of porNome) {
        if (!vistos.has(nome) && !s.busy && !s.pending && !s.queue.length) porNome.delete(nome)
      }
    },

    list: () => ordenar([...porNome.values()].filter((s) => s.id)),
    get: (name) => porNome.get(name),
    active: () => (activeSession && porNome.get(activeSession)?.id ? porNome.get(activeSession) : undefined),

    async create({ cwd, name, activate = true } = {}) {
      const explicito = name?.trim()
      const nome = explicito || SESSAO_PADRAO

      // No name means "wherever my messages go by default". A `home` that is
      // already in the deck is exactly that — reuse it rather than fail.
      const existente = porNome.get(nome)
      if (existente?.id) {
        if (explicito) throw new Error(`a sessão ${nome} já existe`)
        if (activate) activeSession = nome
        persist()
        return existente
      }
      if (!NOME_VALIDO.test(nome)) {
        throw new Error('nome inválido: use até 24 caracteres entre letras, números, - e _')
      }

      await deck.create({ cwd: expandir(cwd, defaultCwd), name: nome, group: GRUPO })
      await api.refresh()
      const sessao = porNome.get(nome)
      if (!sessao?.id) throw new Error(`criei ${nome}, mas ela não apareceu no agent-deck`)
      if (activate) activeSession = nome
      persist()
      return sessao
    },

    setActive(name) {
      if (!porNome.get(name)?.id) return false
      activeSession = name
      persist()
      return true
    },

    // Stops, never deletes: a typo on a phone must not destroy a conductor and
    // its conversation. Deleting stays a deck operation.
    async end(name) {
      const s = porNome.get(name)
      if (!s?.id) return false
      s.abort?.abort()
      await deck.stop(name)
      s.status = 'stopped'
      if (activeSession === name) activeSession = null
      persist()
      return true
    },

    beginRun(name, prompt) {
      const s = porNome.get(name)
      if (!s) return
      s.pending = { prompt, startedAt: now() }
      persist()
    },

    endRun(name) {
      const s = porNome.get(name)
      if (!s) return
      s.pending = null
      persist()
    },

    enqueue(name, prompt) {
      const s = porNome.get(name)
      if (!s) return
      s.queue.push(prompt)
      persist()
    },

    dequeue(name) {
      const s = porNome.get(name)
      if (!s) return null
      const prompt = s.queue.shift() ?? null
      persist()
      return prompt
    },

    clearQueue(name) {
      const s = porNome.get(name)
      if (!s) return
      s.queue.length = 0
      persist()
    },

    interrompidas: () => [...porNome.values()].filter((s) => s.pending && !s.busy),

    touch(name) {
      const s = porNome.get(name)
      if (s) s.lastActivityAt = now()
    },

    // The deck kept working while this process was down; only the delivery
    // was lost. Lets recovery hand over what arrived in the meantime.
    lastReply: (name) => deck.lastReply(name),
  }

  return api
}
