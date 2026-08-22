import { join } from 'node:path'
import { loadConfig } from './config.js'
import { createStore } from './store.js'
import { createSessions } from './sessions.js'
import { createHandler } from './handler.js'
import { createWhatsapp } from './whatsapp.js'
import { createApi } from './api.js'
import { runClaude } from './claude.js'

const log = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[erro] ${m}`),
  debug: (m) => { if (process.env.CLAUDE_WPP_DEBUG) console.log(`[debug] ${m}`) },
}

async function main() {
  const config = loadConfig()
  const store = createStore(join(config.stateDir, 'state.json'))
  const sessions = createSessions({ store, defaultCwd: config.defaultCwd })

  // whatsapp e handler se referenciam: o adaptador entrega a mensagem ao
  // handler, o handler responde pelo adaptador. A seta abaixo é preguiçosa,
  // então `handler` já existe quando a primeira mensagem chega.
  const whatsapp = createWhatsapp({
    authDir: join(config.stateDir, 'wa-auth'),
    authorizedNumber: config.authorizedNumber,
    onMessage: (texto) => handler.handle(texto).catch((e) => log.error(e.stack ?? e.message)),
    log,
  })

  const handler = createHandler({
    sessions,
    run: runClaude,
    reply: (texto) => whatsapp.sendText(config.authorizedNumber, texto),
    config,
  })

  const api = createApi({
    host: config.apiHost,
    port: config.apiPort,
    token: config.apiToken,
    whatsapp,
    sessionCount: () => sessions.list().length,
  })

  for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, async () => {
      log.info(`recebi ${sinal}, encerrando`)
      await api.close().catch(() => {})
      process.exit(0)
    })
  }

  log.info(`${sessions.list().length} sessão(ões) recuperada(s) do estado.`)
  await whatsapp.connect()
  const porta = await api.listen()
  log.info(`API ouvindo em http://${config.apiHost}:${porta}`)
}

main().catch((err) => {
  log.error(err.message)
  if (process.env.CLAUDE_WPP_DEBUG) console.error(err.stack)
  process.exit(1)
})
