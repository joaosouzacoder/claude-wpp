import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { readLastReply } from './transcript.js'

const NOME_VALIDO = /^[a-z0-9_-]{1,24}$/i

export function expandir(cwd, defaultCwd) {
  const bruto = cwd?.trim() ? cwd.trim() : defaultCwd
  const expandido = bruto === '~' ? homedir() : bruto.replace(/^~\//, `${homedir()}/`)
  const absoluto = resolve(defaultCwd, expandido)
  let info
  try {
    info = statSync(absoluto)
  } catch {
    throw new Error(`o diretório ${absoluto} não existe`)
  }
  if (!info.isDirectory()) throw new Error(`${absoluto} não é um diretório`)
  return absoluto
}

// `busy` and `abort` describe the live process and mean nothing on disk.
// `pending` and `queue` are requests you made: dropping them loses work in
// silence, which is the one thing this daemon must never do.
const PERSISTIDO = ['name', 'cwd', 'claudeSessionId', 'createdAt', 'lastActivityAt', 'pending', 'queue']

export function createSessions({ store, defaultCwd = homedir(), now = () => new Date().toISOString() }) {
  const salvo = store.load()

  const sessions = salvo.sessions.map((s) => ({
    name: s.name,
    cwd: s.cwd,
    claudeSessionId: s.claudeSessionId ?? null,
    createdAt: s.createdAt ?? now(),
    lastActivityAt: s.lastActivityAt ?? now(),
    // A revived session is running nothing: the process that ran it is dead.
    // `pending` surviving means the reply is owed, not that work is happening.
    pending: s.pending ?? null,
    queue: Array.isArray(s.queue) ? s.queue : [],
    busy: false,
    abort: null,
  }))

  let activeSession = sessions.some((s) => s.name === salvo.activeSession) ? salvo.activeSession : null

  function persist() {
    store.save({
      sessions: sessions.map((s) => Object.fromEntries(PERSISTIDO.map((k) => [k, s[k]]))),
      activeSession,
    })
  }

  function proximoNome() {
    for (let i = 1; ; i += 1) {
      const nome = `s${i}`
      if (!sessions.some((s) => s.name === nome)) return nome
    }
  }

  const api = {
    list: () => sessions,
    get: (name) => sessions.find((s) => s.name === name),
    active: () => sessions.find((s) => s.name === activeSession),

    // `claudeSessionId` lets /importar register a conversation that already
    // exists (started outside the bot) instead of always starting fresh.
    create({ cwd, name, activate = true, claudeSessionId = null } = {}) {
      const nome = name?.trim() || proximoNome()
      if (!NOME_VALIDO.test(nome)) {
        throw new Error('nome inválido: use até 24 caracteres entre letras, números, - e _')
      }
      if (api.get(nome)) throw new Error(`a sessão ${nome} já existe`)

      const sessao = {
        name: nome,
        cwd: expandir(cwd, defaultCwd),
        claudeSessionId,
        createdAt: now(),
        lastActivityAt: now(),
        pending: null,
        queue: [],
        busy: false,
        abort: null,
      }
      sessions.push(sessao)
      if (activate) activeSession = nome
      persist()
      return sessao
    },

    setActive(name) {
      if (!api.get(name)) return false
      activeSession = name
      persist()
      return true
    },

    // Discarding a busy session's queue in silence is exactly the invariant
    // this file otherwise protects (see PERSISTIDO above): the caller gets
    // the count back so it can say so instead of the prompts just vanishing.
    end(name) {
      const i = sessions.findIndex((s) => s.name === name)
      if (i === -1) return false
      const sessao = sessions[i]
      const queueDropped = sessao.queue.length
      sessao.abort?.abort()
      sessions.splice(i, 1)
      if (activeSession === name) activeSession = sessions.at(-1)?.name ?? null
      persist()
      return { name, queueDropped }
    },

    beginRun(name, prompt) {
      const s = api.get(name)
      if (!s) return
      s.pending = { prompt, startedAt: now() }
      persist()
    },

    endRun(name) {
      const s = api.get(name)
      if (!s) return
      s.pending = null
      persist()
    },

    enqueue(name, prompt) {
      const s = api.get(name)
      if (!s) return
      s.queue.push(prompt)
      persist()
    },

    dequeue(name) {
      const s = api.get(name)
      if (!s) return null
      const prompt = s.queue.shift() ?? null
      persist()
      return prompt
    },

    clearQueue(name) {
      const s = api.get(name)
      if (!s) return
      s.queue.length = 0
      persist()
    },

    interrompidas: () => sessions.filter((s) => s.pending && !s.busy),

    touch(name) {
      const s = api.get(name)
      if (!s) return
      s.lastActivityAt = now()
      persist()
    },

    // The underlying claude session runs detached from this process, so it
    // can finish a turn while a restart is in progress. Lets recovery hand
    // over what arrived in the meantime instead of asking to redo it.
    async lastReply(name) {
      const s = api.get(name)
      if (!s?.claudeSessionId) return null
      return await readLastReply({ cwd: s.cwd, sessionId: s.claudeSessionId })
    },
  }

  return api
}
