// A session that answers when nobody asked it anything.
//
// The bot reads the reply to the turn it typed and then stops listening. But a
// session that dispatched a background agent goes quiet, gets a
// `<task-notification>` minutes later and writes the real answer then — long
// after that turn ended. Nothing was watching, so the answer stayed in the
// session and he only saw it when he asked again.
//
// So each session's transcript is read periodically, and anything it said on
// its own is forwarded to WhatsApp.

import { readEntries } from './transcript.js'

// What marks a line as coming from the machine rather than from him: those are
// the ones that make the session speak without being asked.
const AVISO_DE_MAQUINA = /^\s*<(task-notification|system-reminder)/

// A message is only forwarded once it has been sitting still for this long:
// Claude Code writes several as it works, and the last one is the answer.
const SOSSEGO_MS = 8000

export function createWatcher({
  sessions,
  enviar,
  ler = readEntries,
  now = () => Date.now(),
  quietMs = SOSSEGO_MS,
  log = null,
} = {}) {
  // Where each session was last read. Starting at "now" on first sight, so a
  // restart never replays a conversation's backlog into his chat.
  const marcos = new Map()

  async function olhar(sessao) {
    // A turn of ours is in flight: that path already delivers the reply, and
    // reading the same messages here would send them twice.
    if (sessao.busy || !sessao.claudeSessionId || !sessao.cwd) return null

    const marco = marcos.get(sessao.name) ?? null
    const entradas = await ler({ cwd: sessao.cwd, sessionId: sessao.claudeSessionId, desde: marco })
    if (marco === null) {
      // First look: note where the conversation is and say nothing about what
      // came before.
      marcos.set(sessao.name, entradas.at(-1)?.timestamp ?? new Date(now()).toISOString())
      return null
    }
    if (!entradas.length) return null

    // Walk forward keeping track of what prompted each answer. Only what
    // followed a machine notice counts as the session speaking on its own;
    // an answer to something he typed in the terminal is his to read there.
    let sozinha = false
    let ultima = null
    for (const entrada of entradas) {
      if (entrada.tipo === 'user') {
        sozinha = AVISO_DE_MAQUINA.test(entrada.texto)
        continue
      }
      if (sozinha) ultima = entrada
    }

    const fim = entradas.at(-1).timestamp
    if (!ultima) {
      marcos.set(sessao.name, fim)
      return null
    }

    // Still writing: leave the mark where it is and pick it up next pass, so
    // the answer goes out whole instead of in the middle.
    if (now() - Date.parse(ultima.timestamp) < quietMs) return null

    marcos.set(sessao.name, fim)
    return ultima.texto
  }

  return {
    // For tests and for the boot path: pretend we have already seen
    // everything up to here.
    marcar(nome, timestamp) {
      marcos.set(nome, timestamp)
    },

    async passar() {
      for (const sessao of sessions.list()) {
        try {
          const texto = await olhar(sessao)
          if (!texto) continue
          // Worth a line in the journal: this is the bot speaking with nobody
          // having asked, and the only way to tell it apart from a turn.
          log?.info?.(`[vigia ${sessao.name}] encaminhei ${texto.length} caractere(s) que a sessão disse sozinha`)
          await enviar(sessao.name, texto)
        } catch (err) {
          log?.debug?.(`[watcher ${sessao.name}] ${err.message ?? err}`)
        }
      }
    },
  }
}
