import { openDb } from './db.js'
import { createCapture } from './capture.js'
import { createOutbox } from './outbox.js'
import { createWhatsapp, aceitaTudo, credenciaisValidas } from './whatsapp.js'
import { createWpp } from './wpp.js'
import { createScheduler } from './scheduler.js'
import { runClaude } from './claude.js'

// index.js runs main() the moment it is imported (see the bottom of that
// file), which makes anything defined inline there untestable without also
// triggering a real boot. These two wiring functions live here instead so a
// test can import and call them directly.

// The personal account only exists once it has been paired by hand. A QR printed
// into the journal is a QR nobody can scan, so the daemon has to be sure before
// it dials — see credenciaisValidas.
export function contaPessoalPareada(config) {
  return Boolean(config.personalNumber) && credenciaisValidas(config.personalAuthDir)
}

export function montarContaPessoal(config, avisar, log) {
  const db = openDb(config.dbPath)
  const capture = createCapture({ db })
  const outbox = createOutbox({ db })

  // Records and stays silent. There is no path from "a message arrived on my
  // personal WhatsApp" to "Claude does something" — that is the whole point of
  // "only when I ask".
  const me = createWhatsapp({
    authDir: config.personalAuthDir,
    accept: aceitaTudo,
    downloadMedia: false,
    onMessage: ({ raw }) => { capture.record(raw) },
    onHistory: (mensagens) => {
      let n = 0
      for (const m of mensagens) if (capture.record(m)) n += 1
      if (n) log.info(`[pessoal] ${n} mensagem(ns) de histórico gravada(s).`)
    },
    onChats: (chats) => { for (const c of chats) capture.rememberChat(c) },
    label: 'pessoal',
    log,
  })

  const wpp = createWpp({
    db,
    outbox,
    wa: me,
    run: runClaude,
    config: {
      claudeBin: config.claudeBin,
      agentCwd: config.agentCwd,
      timeoutMs: config.timeoutMs,
      timezone: config.timezone,
    },
  })

  const scheduler = createScheduler({
    outbox,
    send: wpp.send,
    decide: wpp.decide,
    notify: avisar,
    toleranceSec: config.scheduleToleranceSec,
    timezone: config.timezone,
    intervalMs: config.schedulerIntervalMs,
    log,
  })

  return { db, me, outbox, wpp, scheduler }
}
