import { join } from 'node:path'
import { loadConfig } from './config.js'
import { createStore } from './store.js'
import { createSessions } from './sessions.js'
import { createHandler } from './handler.js'
import { createWhatsapp, aceitaDoBot, aceitaTudo, credenciaisValidas } from './whatsapp.js'
import { createApi } from './api.js'
import { runClaude } from './claude.js'
import { transcribe } from './transcribe.js'
import { openDb } from './db.js'
import { createCapture } from './capture.js'
import { createOutbox } from './outbox.js'
import { createScheduler } from './scheduler.js'
import { createWpp, formatDraft } from './wpp.js'

const log = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[erro] ${m}`),
  debug: (m) => { if (process.env.CLAUDE_WPP_DEBUG) console.log(`[debug] ${m}`) },
}

// The personal account only exists once it has been paired by hand. A QR printed
// into the journal is a QR nobody can scan, so the daemon has to be sure before
// it dials — see credenciaisValidas.
function contaPessoalPareada(config) {
  return Boolean(config.personalNumber) && credenciaisValidas(config.personalAuthDir)
}

function montarContaPessoal(config, avisar) {
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

async function main() {
  const config = loadConfig()
  const store = createStore(join(config.stateDir, 'state.json'))
  const sessions = createSessions({ store, defaultCwd: config.defaultCwd })

  // The adapter delivers to the handler and the handler replies through the
  // adapter, so one of them has to exist first. The bot now connects before the
  // handler is built — a message arriving in that window is dropped with a log
  // line instead of crashing on a binding that is not initialised yet.
  let handler = null

  const whatsapp = createWhatsapp({
    authDir: config.botAuthDir,
    mediaDir: config.mediaDir,
    accept: (key) => aceitaDoBot(key, config.authorizedNumber),
    onMessage: (msg) => {
      if (!handler) return log.warn('mensagem chegou antes do handler subir; ignorada.')
      return handler.handle(msg).catch((e) => log.error(e.stack ?? e.message))
    },
    label: 'bot',
    log,
  })

  const avisar = (texto) => whatsapp.sendText(config.authorizedNumber, texto)

  log.info(`${sessions.list().length} sessão(ões) recuperada(s) do estado.`)
  await whatsapp.connect()

  let pessoal = contaPessoalPareada(config) ? montarContaPessoal(config, avisar) : null
  if (!pessoal && config.personalNumber) {
    log.warn('conta pessoal configurada mas não pareada — rode `npm run pair:me`.')
  }

  // The bot is the half that must never go down. If the personal account fails
  // to come up, its commands say so and everything else keeps working: losing
  // the whole daemon over the optional half is far worse than losing the half.
  if (pessoal) {
    try {
      await pessoal.me.connect()
      pessoal.scheduler.start()
      log.info(`conta pessoal ligada; ${pessoal.outbox.pending().length} rascunho(s) esperando aprovação.`)
    } catch (err) {
      log.error(`conta pessoal não subiu: ${err.message}. Sigo sem ela — rode \`npm run pair:me\`.`)
      pessoal.scheduler.stop()
      pessoal.db.close()
      pessoal = null
    }
  }

  handler = createHandler({
    sessions,
    run: runClaude,
    transcribe,
    reply: avisar,
    config,
    wpp: pessoal && {
      outbox: pessoal.outbox,
      agentCwd: config.agentCwd,
      tick: pessoal.scheduler.tick,
      timezone: config.timezone,
      undo: pessoal.wpp.undo,
    },
  })

  const api = createApi({
    host: config.apiHost,
    port: config.apiPort,
    token: config.apiToken,
    whatsapp,
    sessionCount: () => sessions.list().length,
    outbox: pessoal?.outbox ?? null,
    onDraft: pessoal ? (job) => avisar(formatDraft(job, config.timezone)) : null,
    personalState: pessoal ? () => pessoal.me.state() : null,
  })

  for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, async () => {
      log.info(`recebi ${sinal}, encerrando`)
      pessoal?.scheduler.stop()
      pessoal?.db.close()
      await api.close().catch(() => {})
      process.exit(0)
    })
  }

  const porta = await api.listen()
  log.info(`API ouvindo em http://${config.apiHost}:${porta}`)
}

main().catch((err) => {
  log.error(err.message)
  if (process.env.CLAUDE_WPP_DEBUG) console.error(err.stack)
  process.exit(1)
})
