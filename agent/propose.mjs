#!/usr/bin/env node
// Proposes a message. It is NOT sent: it lands as a pending draft and only an
// explicit /ok from the authorized number on WhatsApp releases it.
//
//   node propose.mjs --to <chat_jid> --body "texto"
//   node propose.mjs --to <chat_jid> --body "texto" --quote <wa_id>
//   node propose.mjs --to <chat_jid> --body "texto" --at "2026-08-28T09:00:00-03:00"
//   node propose.mjs --to <chat_jid> --body "texto" --at ... --check "ele já respondeu?"
import { loadConfig } from '../src/config.js'

const args = process.argv.slice(2)
const pegar = (nome) => {
  const i = args.indexOf(`--${nome}`)
  return i === -1 ? null : args[i + 1]
}

const to = pegar('to')
const body = pegar('body')
const at = pegar('at')
const check = pegar('check')

if (!to || !body) {
  console.error('uso: node propose.mjs --to <chat_jid> --body "texto" [--quote <wa_id>] [--at <iso>] [--check "pergunta"]')
  process.exit(1)
}

let scheduledFor = null
if (at) {
  const t = new Date(at)
  if (Number.isNaN(t.getTime())) {
    console.error(`não entendi a data "${at}". Use ISO 8601, ex.: 2026-08-28T09:00:00-03:00`)
    process.exit(1)
  }
  scheduledFor = Math.floor(t.getTime() / 1000)
}

const config = loadConfig()
const r = await fetch(`http://${config.apiHost}:${config.apiPort}/outbox`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiToken}` },
  body: JSON.stringify({
    kind: check ? 'conditional' : 'message',
    chatJid: to,
    chatName: pegar('name'),
    body,
    quotedWaId: pegar('quote'),
    checkPrompt: check,
    scheduledFor,
  }),
})

const resposta = await r.json()
if (!r.ok || !resposta.ok) {
  console.error(`recusado (${r.status}): ${resposta.error ?? 'sem motivo'}`)
  process.exit(1)
}

console.log(`rascunho #${resposta.id} criado e aguardando o /ok do dono da conta.`)
