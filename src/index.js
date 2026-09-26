import { join } from 'node:path'
import { loadConfig } from './config.js'
import { createStore } from './store.js'
import { createSessions } from './sessions.js'
import { createHandler } from './handler.js'
import { createWhatsapp, aceitaDoBot } from './whatsapp.js'
import { createApi } from './api.js'
import { runClaude, attachClaude, listAgents, execCli } from './claude.js'
import { createAttachedRunner } from './attached.js'
import { createWatcher } from './watcher.js'
import { classificadorClaude } from './intent.js'
import { transcribe } from './transcribe.js'
import { formatDraft, formatDirect } from './wpp.js'
import { contaPessoalPareada, montarContaPessoal } from './boot.js'
import { limparMediaAntiga } from './media.js'
import { createNotifier } from './notify.js'
import { createContactResolver } from './contacts.js'
import { createRelay, promptFormal, limparFormal } from './relay.js'
import { createTasks } from './tasks.js'
import { openDb } from './db.js'
import { mkdirSync } from 'node:fs'

// Rewriting one short reply formally; past this, the owner is told it was not sent.
const FORMALIZAR_TIMEOUT_MS = 3 * 60 * 1000
// How often each session's transcript is re-read for something it said with
// no turn of ours in flight. Reading a tail off disk, so it can be frequent.
const VIGIA_INTERVALO_MS = 15 * 1000
// How often the media directories are swept. Files age out at
// config.mediaMaxAgeMs; this only decides how late a file can be to leave.
const VARREDURA_MIDIA_MS = 6 * 60 * 60 * 1000

const log = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[erro] ${m}`),
  debug: (m) => { if (process.env.CLAUDE_WPP_DEBUG) console.log(`[debug] ${m}`) },
}

async function main() {
  const config = loadConfig({ log })

  // Retention has to hold on a process that stays up for weeks, so the sweep
  // runs on a clock and not only here. Both directories age out together.
  const pastasDeMidia = [config.mediaDir, config.personalMediaDir]
  const varrerMidia = () => {
    for (const dir of pastasDeMidia) {
      const removidos = limparMediaAntiga({ dir, maxAgeMs: config.mediaMaxAgeMs })
      if (removidos) log.info(`${removidos} arquivo(s) de mídia com mais de ${Math.round(config.mediaMaxAgeMs / 86400000)} dia(s) removido(s) de ${dir}.`)
    }
  }
  varrerMidia()

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
    // Replies from people the bot wrote to are relayed to the owner; nothing
    // from anyone else reaches the handler.
    onOther: (m) => (relay ? relay.onOther(m).catch((e) => log.error(`[relay] ${e.stack ?? e.message}`)) : undefined),
    label: 'bot',
    log,
  })

  const relayDb = openDb(config.dbPath)
  const tarefas = createTasks({ db: relayDb, timezone: config.timezone })
  const dirFormal = join(config.stateDir, 'formal')
  mkdirSync(dirFormal, { recursive: true })
  let relay = null

  // Every send the bot makes goes through here, so whoever it writes to —
  // through the API, a /bot draft, an attachment — is someone whose reply
  // will be relayed.
  const bot = {
    ...whatsapp,
    async sendText(destino, texto, opts) {
      const id = await whatsapp.sendText(destino, texto, opts)
      relay?.noteSent(destino, texto)
      return id
    },
    async sendDocument(destino, doc) {
      const id = await whatsapp.sendDocument(destino, doc)
      relay?.noteSent(destino, [doc?.fileName ? `(arquivo: ${doc.fileName})` : null, doc?.caption].filter(Boolean).join(' '))
      return id
    },
  }

  const avisar = (texto) => bot.sendText(config.authorizedNumber, texto)

  // One rewrite into formal Portuguese, for everything that goes out through
  // the bot: relayed answers and drafts approved with /bot.
  const formalizarComClaude = async (prompt) => {
    const r = await runClaude({ bin: config.claudeBin, cwd: dirFormal, prompt, timeoutMs: FORMALIZAR_TIMEOUT_MS })
    if (!r.ok) throw new Error(r.error ?? 'o claude falhou sem descrição')
    return r.text
  }

  // Triage and small talk read a stranger's words, so this one runs with no
  // tools at all: it can produce text and nothing else.
  const triagemComClaude = async (prompt) => {
    const r = await execCli(config.claudeBin, ['-p', '--model', config.triageModel, '--tools', '', '--setting-sources', 'project', '--strict-mcp-config', prompt], { cwd: dirFormal, timeoutMs: config.triageTimeoutMs })
    if (r.code !== 0) throw new Error(r.timedOut ? 'tempo esgotado' : (String(r.stderr ?? '').trim().slice(0, 200) || `código ${r.code}`))
    return r.stdout
  }

  relay = createRelay({
    db: relayDb,
    triage: triagemComClaude,
    ownerNumber: config.authorizedNumber,
    notifyOwner: avisar,
    sendAsBot: (destino, texto) => bot.sendText(destino, texto),
    formalize: formalizarComClaude,
    assistente: config.assistantName,
    log,
  })

  log.info(`${sessions.list().length} sessão(ões) recuperada(s) do estado.`)
  await whatsapp.connect()

  let pessoal = contaPessoalPareada(config) ? montarContaPessoal(config, avisar, log, bot) : null
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
    // Answering inside a session he opened himself, by typing into it.
    runAttached: createAttachedRunner({ bin: config.claudeBin, log }),
    classify: classificadorClaude({ bin: config.claudeBin, model: config.intentModel, cwd: dirFormal, timeoutMs: config.intentTimeoutMs }),
    log,
    sessions,
    run,
    attach: attachClaude,
    transcribe,
    reply: avisar,
    replyFile: (documento) => whatsapp.sendDocument(config.authorizedNumber, documento),
    config,
    listAgents,
    relay,
    wpp: pessoal && {
      outbox: pessoal.outbox,
      agentCwd: config.agentCwd,
      botContatos: () => relay.contatos(),
      assistente: config.assistantName,
      tick: pessoal.scheduler.tick,
      timezone: config.timezone,
      undo: pessoal.wpp.undo,
      formalizar: async ({ nome, texto, destino }) => limparFormal(await formalizarComClaude(
        promptFormal({ nome, resposta: texto, historico: relay.historico(destino), assistente: config.assistantName }),
      )),
    },
  })

  // A run killed with the process never answered. Now that the request survives
  // in the state file, boot is where that debt gets paid.
  await handler.recuperar().catch((e) => log.error(e.stack ?? e.message))

  const api = createApi({
    host: config.apiHost,
    port: config.apiPort,
    token: config.apiToken,
    whatsapp: bot,
    sessionCount: () => sessions.list().length,
    outbox: pessoal?.outbox ?? null,
    onDraft: pessoal ? (job) => avisar(formatDraft(job, config.timezone)) : null,
    onDirect: pessoal
      ? async (job) => {
        await pessoal.scheduler.tick()
        await avisar(formatDirect(job, config.timezone))
      }
      : null,
    // Rebuilding the request as `/wpp <pedido>` and handing it to the same
    // handler is what makes the HTTP route and the typed command the same
    // thing: one implementation, one set of instructions, no way to drift. It
    // also pins the command — a caller cannot reach `/ok` or another session.
    onWpp: pessoal
      ? (pedido) => { handler.handle(`/wpp ${pedido}`).catch((e) => log.error(e.stack ?? e.message)) }
      : null,
    // The butler's hands: it hands work to a project session the same way a
    // typed `@sessão` does, so the reply reaches the owner labelled with that
    // session's name, on that session's own clock.
    onDispatch: ({ session, prompt, cwd }) => handler.despacharDeFora({ session, prompt, cwd }),
    onUndo: pessoal ? () => pessoal.wpp.undo() : null,
    tasks: pessoal ? tarefas : null,
    sessionList: () => sessions.list().map((s) => ({ name: s.name, cwd: s.cwd, busy: Boolean(s.busy) })),
    personalState: pessoal ? () => pessoal.me.state() : null,
    notifier: createNotifier({ send: avisar, dedupMs: config.notifyDedupMs }),
    contacts: pessoal ? createContactResolver(pessoal.db) : null,
    mediaDir: config.mediaDir,
  })

  // The hour arriving is the only thing that starts a task; a run that throws
  // must not take the timer with it, or one bad task silently ends all of them.
  const relogioTarefas = pessoal
    ? setInterval(() => {
      for (const tarefa of tarefas.due()) {
        tarefas.ranOnce(tarefa.id)
        handler.rodarTarefa({ id: tarefa.id, prompt: tarefa.prompt, label: tarefa.label })
          .catch((e) => log.error(`[tarefa ${tarefa.id}] ${e.stack ?? e.message}`))
      }
    }, config.schedulerIntervalMs)
    : null
  relogioTarefas?.unref?.()

  // A session finishes something it had handed to a background agent and says
  // so minutes after the turn ended. Nobody is reading then, so that answer
  // used to sit in the session until he asked about it again.
  const vigia = createWatcher({
    sessions,
    enviar: (nome, texto) => handler.avisarDaSessao(nome, texto),
    log,
  })
  const relogioMidia = setInterval(varrerMidia, VARREDURA_MIDIA_MS)
  relogioMidia.unref?.()

  const relogioVigia = setInterval(() => {
    vigia.passar().catch((e) => log.debug?.(`[vigia] ${e.message ?? e}`))
  }, VIGIA_INTERVALO_MS)
  relogioVigia.unref?.()

  for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, async () => {
      log.info(`recebi ${sinal}, encerrando`)
      if (relogioTarefas) clearInterval(relogioTarefas)
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
