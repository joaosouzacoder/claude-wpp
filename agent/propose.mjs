#!/usr/bin/env node
// Proposes a message. It is NOT sent: it lands as a pending draft and only an
// explicit /ok (as the owner) or /bot (as the bot) on WhatsApp releases it.
//
// Every draft carries two wordings: --body in the owner's own voice, sent by
// /ok, and --body-bot, the formal version sent by /bot.
//
//   node propose.mjs --to <chat_jid> --body "texto" --body-bot "texto formal"
//   ... --quote <wa_id>
//   ... --at "2026-08-28T09:00:00-03:00" [--check "ele já respondeu?"]
//   ... --attach <path under the media dir> --attach-name "nome.pdf"
//   ... --send-as me|bot   only when the request says direct sending is
//                          authorized; the server checks that, and without it
//                          the draft simply waits for approval as usual
import { loadConfig } from '../src/config.js'

const args = process.argv.slice(2)
const pegar = (nome) => {
  const i = args.indexOf(`--${nome}`)
  return i === -1 ? null : args[i + 1]
}

const to = pegar('to')
const body = pegar('body')
const bodyBot = pegar('body-bot')
const at = pegar('at')
const check = pegar('check')
const attach = pegar('attach')
const sendAs = pegar('send-as')

if (!to || !body) {
  console.error('uso: node propose.mjs --to <chat_jid> --body "texto" --body-bot "texto formal" [--quote <wa_id>] [--at <iso>] [--check "pergunta"] [--attach <caminho> --attach-name <nome>]')
  process.exit(1)
}

if (!bodyBot?.trim()) {
  console.error('falta --body-bot: a versão formal da mesma mensagem, que é a que sai se ele aprovar com /bot (pelo número do bot). Mesmo conteúdo, tom formal e cordial, sem gírias. Rode de novo com as duas versões.')
  process.exit(1)
}

if (sendAs && !['me', 'bot'].includes(sendAs)) {
  console.error('--send-as tem que ser "me" ou "bot"')
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
    bodyBot,
    quotedWaId: pegar('quote'),
    checkPrompt: check,
    scheduledFor,
    ...(attach ? { attachment: { path: attach, name: pegar('attach-name') } } : {}),
    ...(sendAs ? { sendAs } : {}),
  }),
  signal: AbortSignal.timeout(30000),
})

const resposta = await r.json()
if (!r.ok || !resposta.ok) {
  console.error(`recusado (${r.status}): ${resposta.error ?? 'sem motivo'}`)
  process.exit(1)
}

if (resposta.sent) {
  console.log(`#${resposta.id} enviado direto ${resposta.sent === 'bot' ? 'pelo bot' : 'como o dono da conta'}.`)
} else {
  if (resposta.warning) console.log(resposta.warning)
  console.log(`rascunho #${resposta.id} criado e aguardando o /ok ou /bot do dono da conta.`)
}
