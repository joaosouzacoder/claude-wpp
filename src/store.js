import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const VAZIO = { sessions: [], activeSession: null }

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

    save(state) {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, filePath)
    },
  }
}
