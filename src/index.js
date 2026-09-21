import { join } from 'node:path'
import { loadConfig } from './config.js'
import { createStore } from './store.js'
import { createSessions } from './sessions.js'
import { createHandler } from './handler.js'
import { createWhatsapp, aceitaDoBot } from './whatsapp.js'
import { createApi } from './api.js'
import { runClaude, attachClaude, listAgents } from './claude.js'
import { transcribe } from './transcribe.js'
import { formatDraft } from './wpp.js'
import { contaPessoalPareada, montarContaPessoal } from './boot.js'
import { limparMediaAntiga } from './media.js'
import { createNotifier } from './notify.js'

const log = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[erro] ${m}`),
  debug: (m) => { if (process.env.CLAUDE_WPP_DEBUG) console.log(`[debug] ${m}`) },
}

async function main() {
  const config = loadConfig({ log })

  const mediaRemovida = limparMediaAntiga({ dir: config.mediaDir, maxAgeMs: config.mediaMaxAgeMs })
  if (mediaRemovida) log.info(`${mediaRemovida} arquivo(s) de mídia antigo(s) removido(s) de ${config.mediaDir}.`)

  const sessions = createSessions({ store: createStore(join(config.stateDir, 'state.json')), defaultCwd: config.defaultCwd })
  const run = runClaude

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
      // An unaccounted-for throw here used to only reach the server console —
      // from the phone, that reads exactly like a dropped message, with no
      // reason to retry or report it. A generic reply at least says something
      // broke, on top of the same log line for whoever can actually fix it.
      return handler.handle(msg).catch((e) => {
        log.error(e.stack ?? e.message)
        avisar('Deu um erro inesperado processando sua mensagem. Tenta de novo.').catch(() => {})
      })
    },
    label: 'bot',
    log,
  })

  const avisar = (texto) => whatsapp.sendText(config.authorizedNumber, texto)

  log.info(`${sessions.list().length} sessão(ões) recuperada(s) do estado.`)
  await whatsapp.connect()

  let pessoal = contaPessoalPareada(config) ? montarContaPessoal(config, avisar, log) : null
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
    run,
    attach: attachClaude,
    transcribe,
    reply: avisar,
    replyFile: (documento) => whatsapp.sendDocument(config.authorizedNumber, documento),
    config,
    listAgents,
    wpp: pessoal && {
      outbox: pessoal.outbox,
      agentCwd: config.agentCwd,
      tick: pessoal.scheduler.tick,
      timezone: config.timezone,
      undo: pessoal.wpp.undo,
    },
  })

  // A run killed with the process never answered. Now that the request survives
  // in the state file, boot is where that debt gets paid.
  await handler.recuperar().catch((e) => log.error(e.stack ?? e.message))

  const api = createApi({
    host: config.apiHost,
    port: config.apiPort,
    token: config.apiToken,
    whatsapp,
    sessionCount: () => sessions.list().length,
    outbox: pessoal?.outbox ?? null,
    onDraft: pessoal ? (job) => avisar(formatDraft(job, config.timezone)) : null,
    // Rebuilding the request as `/wpp <pedido>` and handing it to the same
    // handler is what makes the HTTP route and the typed command the same
    // thing: one implementation, one set of instructions, no way to drift. It
    // also pins the command — a caller cannot reach `/ok` or another session.
    onWpp: pessoal
      ? (pedido) => { handler.handle(`/wpp ${pedido}`).catch((e) => log.error(e.stack ?? e.message)) }
      : null,
    personalState: pessoal ? () => pessoal.me.state() : null,
    notifier: createNotifier({ send: avisar, dedupMs: config.notifyDedupMs }),
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
