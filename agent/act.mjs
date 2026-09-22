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
  node act.mjs dispatch --session <nome> --prompt "<pedido>" [--cwd <dir>]
  node act.mjs tarefa --daily 09:00 --prompt "<o que fazer>" [--label "<apelido>"]
  node act.mjs tarefa --at 2026-09-23T09:00:00-03:00 --prompt "<o que fazer>"
  node act.mjs tarefas
  node act.mjs tarefa-fim --id <n>       # já aconteceu, não repete mais
  node act.mjs tarefa-cancela --id <n>`

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
} else if (acao === 'tarefa') {
  const prompt = pegar('prompt')
  const daily = pegar('daily')
  const quando = pegar('at')
  if (!prompt || (!daily && !quando)) {
    console.error(USO)
    process.exit(1)
  }
  let at = null
  if (quando) {
    const t = new Date(quando)
    if (Number.isNaN(t.getTime())) {
      console.error(`não entendi a data "${quando}". Use ISO 8601 com fuso, ex.: 2026-09-23T09:00:00-03:00`)
      process.exit(1)
    }
    at = Math.floor(t.getTime() / 1000)
  }
  const r = await chamar('/tasks', { prompt, label: pegar('label'), dailyAt: daily, at })
  const proximo = new Date(r.nextRun * 1000).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  console.log(`tarefa #${r.id} agendada${r.dailyAt ? ` todo dia às ${r.dailyAt}` : ''}; a primeira vez é ${proximo}.`)
} else if (acao === 'tarefas') {
  const r = await chamar('/tasks')
  if (!r.tasks.length) console.log('(nada agendado)')
  for (const t of r.tasks) {
    const proximo = new Date(t.next_run * 1000).toLocaleString('pt-BR', { timeZone: t.tz ?? 'America/Sao_Paulo' })
    console.log(`#${t.id}\t${t.daily_at ? `todo dia ${t.daily_at}` : 'uma vez'}\tpróxima: ${proximo}\t${t.label ?? t.prompt.slice(0, 60)}`)
  }
} else if (acao === 'tarefa-fim' || acao === 'tarefa-cancela') {
  const id = Number(String(pegar('id') ?? '').replace(/[^0-9]/g, ''))
  if (!id) {
    console.error(USO)
    process.exit(1)
  }
  const r = await chamar('/tasks/close', { id, done: acao === 'tarefa-fim' })
  console.log(`tarefa #${r.id}: ${r.status}.`)
} else {
  console.error(USO)
  process.exit(1)
}
