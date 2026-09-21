import { join } from 'node:path'
import { loadConfig } from './config.js'
import { checar } from './health.js'

// Entry point for systemd/claude-wpp-health.service, run by its timer.
const config = loadConfig({ log: { warn: () => {} } })

if (!config.ntfyTopic) {
  console.log('[health] ntfyTopic não configurado; nada a fazer.')
  process.exit(0)
}

// The daemon may bind to 0.0.0.0; the check always goes through loopback.
const host = config.apiHost === '0.0.0.0' ? '127.0.0.1' : config.apiHost

try {
  const { leitura } = await checar({
    healthzUrl: `http://${host}:${config.apiPort}/healthz`,
    topico: config.ntfyTopic,
    estadoPath: join(config.stateDir, 'health.json'),
  })
  console.log(`[health] ${leitura.saudavel ? 'ok' : `falhou: ${leitura.motivo}`}`)
} catch (err) {
  console.error(`[health] não consegui alertar: ${err.message}`)
  process.exit(1)
}
