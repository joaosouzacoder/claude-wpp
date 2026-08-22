import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const NOME_VALIDO = /^[a-z0-9_-]{1,24}$/i

function expandir(cwd, defaultCwd) {
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

const PERSISTIDO = ['name', 'cwd', 'claudeSessionId', 'createdAt', 'lastActivityAt']

export function createSessions({ store, defaultCwd = homedir(), now = () => new Date().toISOString() }) {
  const salvo = store.load()

  const sessions = salvo.sessions.map((s) => ({
    name: s.name,
    cwd: s.cwd,
    claudeSessionId: s.claudeSessionId ?? null,
    createdAt: s.createdAt ?? now(),
    lastActivityAt: s.lastActivityAt ?? now(),
    busy: false,
    queue: [],
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

    create({ cwd, name } = {}) {
      const nome = name?.trim() || proximoNome()
      if (!NOME_VALIDO.test(nome)) {
        throw new Error('nome inválido: use até 24 caracteres entre letras, números, - e _')
      }
      if (api.get(nome)) throw new Error(`a sessão ${nome} já existe`)

      const sessao = {
        name: nome,
        cwd: expandir(cwd, defaultCwd),
        claudeSessionId: null,
        createdAt: now(),
        lastActivityAt: now(),
        busy: false,
        queue: [],
        abort: null,
      }
      sessions.push(sessao)
      activeSession = nome
      persist()
      return sessao
    },

    setActive(name) {
      if (!api.get(name)) return false
      activeSession = name
      persist()
      return true
    },

    end(name) {
      const i = sessions.findIndex((s) => s.name === name)
      if (i === -1) return false
      sessions[i].abort?.abort()
      sessions.splice(i, 1)
      if (activeSession === name) activeSession = sessions.at(-1)?.name ?? null
      persist()
      return true
    },

    touch(name) {
      const s = api.get(name)
      if (!s) return
      s.lastActivityAt = now()
      persist()
    },
  }

  return api
}
