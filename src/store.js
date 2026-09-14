import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const VAZIO = { sessions: [], activeSession: null }

function gravar(filePath, valor) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp`
  writeFileSync(tmp, JSON.stringify(valor, null, 2))
  renameSync(tmp, filePath)
}

export function createStore(filePath) {
  return {
    load() {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'))
        return {
          sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
          activeSession: typeof raw.activeSession === 'string' ? raw.activeSession : null,
        }
      } catch {
        return structuredClone(VAZIO)
      }
    },

    save: (state) => gravar(filePath, state),
  }
}

// For state that is not sessions. A missing or corrupt file reads as null:
// losing it only costs repeating what it was there to suppress.
export function createJsonFile(filePath) {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(filePath, 'utf8'))
      } catch {
        return null
      }
    },
    save: (valor) => gravar(filePath, valor),
  }
}
