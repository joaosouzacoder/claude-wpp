#!/usr/bin/env node
// The butler's hands. `propose.mjs` writes a draft; this releases it, takes it
// back, or hands work to a project session.
//
//   node act.mjs approve --id 12 --as me|bot   # sends it, now
//   node act.mjs undo                          # deletes the last one sent
//   node act.mjs sessions                      # what project sessions exist
//   node act.mjs dispatch --session infra --prompt "roda os testes" [--cwd <dir>]
import { loadConfig } from '../src/config.js'

const [acao, ...resto] = process.argv.slice(2)
const pegar = (nome) => {
  const i = resto.indexOf(`--${nome}`)
  return i === -1 ? null : resto[i + 1]
}

const USO = `uso:
  node act.mjs approve --id <n> [--as me|bot]
  node act.mjs undo
  node act.mjs sessions
  node act.mjs dispatch --session <nome> --prompt "<pedido>" [--cwd <dir>]`

const config = loadConfig()
const base = `http://${config.apiHost}:${config.apiPort}`
const TIMEOUT_MS = 30000

async function chamar(rota, corpo = null) {
  const r = await fetch(`${base}${rota}`, {
    method: corpo ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiToken}` },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const resposta = await r.json().catch(() => ({}))
  if (!r.ok || !resposta.ok) {
    console.error(`recusado (${r.status}): ${resposta.error ?? 'sem motivo'}`)
    process.exit(1)
  }
  return resposta
}

if (acao === 'approve') {
  const id = Number(String(pegar('id') ?? '').replace(/[^0-9]/g, ''))
  const as = pegar('as') ?? 'me'
  if (!id) {
    console.error(USO)
    process.exit(1)
  }
  const r = await chamar('/approve', { id, sender: as })
  console.log(`#${r.id} enviado ${r.sent === 'bot' ? 'pelo bot' : 'como o dono da conta'}.`)
} else if (acao === 'undo') {
  const r = await chamar('/undo', {})
  console.log(`apaguei a última mensagem para ${r.to}: "${r.body}"`)
} else if (acao === 'sessions') {
  const r = await chamar('/sessions')
  if (!r.sessions.length) console.log('(nenhuma sessão aberta)')
  for (const s of r.sessions) console.log(`${s.name}\t${s.cwd}\t${s.busy ? 'ocupada' : 'livre'}`)
} else if (acao === 'dispatch') {
  const prompt = pegar('prompt')
  if (!prompt) {
    console.error(USO)
    process.exit(1)
  }
  const r = await chamar('/dispatch', { session: pegar('session'), prompt, cwd: pegar('cwd') })
  console.log(`despachado para ${r.session}; a resposta chega no WhatsApp com o nome da sessão na frente.`)
} else {
  console.error(USO)
  process.exit(1)
}
