import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

// When the bot's own WhatsApp is down, WhatsApp is the one channel that cannot
// say so. This runs outside the daemon, on a systemd timer, and alerts
// through ntfy instead.

const HEALTHZ_TIMEOUT_MS = 5000
const NTFY_TIMEOUT_MS = 10000

// A reconnect after a transient drop takes seconds; one bad look is not an
// outage. Alerting only after this many consecutive ones keeps that quiet.
export const FALHAS_PARA_ALERTAR = 2

// What /healthz answered, reduced to the one question: is the bot reachable
// on WhatsApp? `motivo` says why not, for the alert.
export function lerSaude({ ok, status, corpo, erro }) {
  if (erro) return { saudavel: false, motivo: `API não respondeu (${erro})` }
  if (!ok) return { saudavel: false, motivo: `API respondeu HTTP ${status}` }
  if (corpo?.wa !== 'open') return { saudavel: false, motivo: `WhatsApp do bot está "${corpo?.wa ?? '?'}"` }
  return { saudavel: true, motivo: null }
}

// Pure: previous state + this reading → next state and, at most, one alert.
// Alerts on the transition into an outage and on the way out of it, never on
// every failing check in between.
export function avaliar(anterior, leitura, agora, { falhasParaAlertar = FALHAS_PARA_ALERTAR } = {}) {
  const antes = { falhas: 0, alertado: false, desde: null, ...anterior }

  if (leitura.saudavel) {
    const alerta = antes.alertado
      ? { titulo: 'claude-wpp voltou', mensagem: `O bot está de volta no WhatsApp (fora desde ${antes.desde}).`, prioridade: 'default', tags: 'white_check_mark' }
      : null
    return { estado: { falhas: 0, alertado: false, desde: null }, alerta }
  }

  const falhas = antes.falhas + 1
  const desde = antes.desde ?? new Date(agora).toISOString()
  if (!antes.alertado && falhas >= falhasParaAlertar) {
    return {
      estado: { falhas, alertado: true, desde },
      alerta: { titulo: 'claude-wpp fora do ar', mensagem: `${leitura.motivo}. Veja: journalctl --user -u claude-wpp -n 50`, prioridade: 'high', tags: 'rotating_light' },
    }
  }
  return { estado: { falhas, alertado: antes.alertado, desde }, alerta: null }
}

async function consultarHealthz(url, fetcher) {
  try {
    const r = await fetcher(url, { signal: AbortSignal.timeout(HEALTHZ_TIMEOUT_MS) })
    let corpo = null
    try { corpo = await r.json() } catch {}
    return { ok: r.ok, status: r.status, corpo }
  } catch (err) {
    return { erro: err.name === 'TimeoutError' ? 'timeout' : err.message }
  }
}

async function enviarNtfy(topico, { titulo, mensagem, prioridade, tags }, fetcher) {
  const r = await fetcher(`https://ntfy.sh/${encodeURIComponent(topico)}`, {
    method: 'POST',
    headers: { Title: titulo, Priority: prioridade, Tags: tags },
    body: mensagem,
    signal: AbortSignal.timeout(NTFY_TIMEOUT_MS),
  })
  if (!r.ok) throw new Error(`ntfy respondeu HTTP ${r.status}`)
}

function lerEstado(caminho) {
  try {
    return JSON.parse(readFileSync(caminho, 'utf8'))
  } catch {
    return {}
  }
}

// One check. The state file is only advanced once the alert it implies was
// actually delivered: a failed ntfy call retries on the next tick instead of
// swallowing the outage.
export async function checar({ healthzUrl, topico, estadoPath, fetcher = fetch, agora = Date.now(), log = console }) {
  const leitura = lerSaude(await consultarHealthz(healthzUrl, fetcher))
  const { estado, alerta } = avaliar(lerEstado(estadoPath), leitura, agora)
  if (alerta) {
    await enviarNtfy(topico, alerta, fetcher)
    log.info?.(`[health] alerta enviado: ${alerta.titulo}`)
  }
  mkdirSync(dirname(estadoPath), { recursive: true })
  writeFileSync(estadoPath, JSON.stringify(estado))
  return { leitura, alerta }
}
