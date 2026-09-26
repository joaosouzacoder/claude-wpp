import { openDb } from './db.js'
import { createCapture } from './capture.js'
import { createOutbox } from './outbox.js'
import { createWhatsapp, aceitaTudo, credenciaisValidas, MIDIAS_ARQUIVADAS } from './whatsapp.js'
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

// `bot` is the bot's own WhatsApp, used for drafts approved with /bot.
export function montarContaPessoal(config, avisar, log, bot = null) {
  const db = openDb(config.dbPath)
  const capture = createCapture({ db })
  const outbox = createOutbox({ db })

  // Records and stays silent. There is no path from "a message arrived on my
  // personal WhatsApp" to "Claude does something" — that is the whole point of
  // "only when I ask". Downloading a file does not change that: it is written
  // to disk and its path recorded, and nothing reads it until he asks.
  const me = createWhatsapp({
    authDir: config.personalAuthDir,
    accept: aceitaTudo,
    mediaDir: config.personalMediaDir,
    mediaKinds: MIDIAS_ARQUIVADAS,
    maxMediaBytes: config.personalMediaMaxBytes,
    // The log is of the conversation, not of what is actionable: a sticker or
    // a location has no text and no file, and must still become a row.
    entregarSemConteudo: true,
    // Only what people send him. His own outgoing files are already on his
    // phone, and keeping a second copy here buys nothing.
    onMessage: ({ raw, media }) => {
      capture.record(raw, { mediaPath: raw?.key?.fromMe ? null : (media?.path ?? null) })
    },
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
    bot,
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
