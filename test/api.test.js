import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../src/api.js'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'
import { createNotifier } from '../src/notify.js'

const enviados = []
const whatsapp = {
  sendText: async (to, text) => { enviados.push({ to, text }) },
  state: () => 'open',
}

let api
let base

before(async () => {
  api = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp, sessionCount: () => 2 })
  const porta = await api.listen()
  base = `http://127.0.0.1:${porta}`
})

after(async () => { await api.close() })

test('healthz não exige token', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, wa: 'open', sessions: 2 })
})

test('send sem token é 401', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi' }),
  })
  assert.equal(r.status, 401)
})

test('send com token errado é 401', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer errado' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi' }),
  })
  assert.equal(r.status, 401)
})

test('send válido entrega a mensagem', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi' }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true })
  assert.deepEqual(enviados.at(-1), { to: '5511911111111', text: 'oi' })
})

test('send sem campos obrigatórios é 400', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ to: '5511911111111' }),
  })
  assert.equal(r.status, 400)
})

test('send com json inválido é 400', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: '{ nao e json',
  })
  assert.equal(r.status, 400)
})

test('rota desconhecida é 404', async () => {
  const r = await fetch(`${base}/qualquer`)
  assert.equal(r.status, 404)
})

test('GET em /send é 405', async () => {
  const r = await fetch(`${base}/send`)
  assert.equal(r.status, 405)
})

// --- POST /outbox: o único caminho do claude para a sua conta pessoal ---

let apiOut, baseOut, outbox
const avisos = []

before(async () => {
  const db = openDb(':memory:')
  outbox = createOutbox({ db, now: () => 1000 })
  apiOut = createApi({
    host: '127.0.0.1', port: 0, token: 'segredo', whatsapp,
    outbox, onDraft: async (job) => { avisos.push(job) },
  })
  baseOut = `http://127.0.0.1:${await apiOut.listen()}`
})

after(async () => { await apiOut.close() })

const propor = (corpo, token = 'segredo') => fetch(`${baseOut}/outbox`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(corpo),
})

test('outbox sem token é 401', async () => {
  assert.equal((await propor({ chatJid: '5@s.whatsapp.net', body: 'oi' }, 'errado')).status, 401)
})

test('rascunho criado nasce pendente e nunca é enviado sozinho', async () => {
  const antes = enviados.length
  const r = await propor({ chatJid: '5@s.whatsapp.net', chatName: 'Jane', body: 'traz o macbook' })
  assert.equal(r.status, 200)
  const { ok, id } = await r.json()
  assert.equal(ok, true)
  assert.equal(outbox.get(id).status, 'pending')
  assert.equal(enviados.length, antes)
})

test('criar rascunho avisa o dono, senão ele nunca saberia que existe', async () => {
  const antes = avisos.length
  await propor({ chatJid: '5@s.whatsapp.net', body: 'oi' })
  assert.equal(avisos.length, antes + 1)
})

test('rascunho inválido é 400 com o motivo', async () => {
  const r = await propor({ chatJid: '', body: 'oi' })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /destino/)
})

test('condicional sem verificação é recusada', async () => {
  const r = await propor({ chatJid: '5@s.whatsapp.net', body: 'oi', kind: 'conditional' })
  assert.equal(r.status, 400)
})

test('agendamento guarda a hora marcada', async () => {
  const r = await propor({ chatJid: '5@s.whatsapp.net', body: 'oi', scheduledFor: 1756382400 })
  const { id } = await r.json()
  assert.equal(outbox.get(id).scheduled_for, 1756382400)
})

test('sem conta pessoal ligada, /outbox responde 503 em vez de fingir', async () => {
  const semOutbox = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp })
  const porta = await semOutbox.listen()
  const r = await fetch(`http://127.0.0.1:${porta}/outbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ chatJid: '5@s.whatsapp.net', body: 'oi' }),
  })
  assert.equal(r.status, 503)
  await semOutbox.close()
})

// --- POST /wpp: a mesma porta do /wpp digitado no WhatsApp, de outra máquina ---

let apiWpp, baseWpp
const pedidos = []
let travar = null

before(async () => {
  apiWpp = createApi({
    host: '127.0.0.1', port: 0, token: 'segredo', whatsapp,
    onWpp: (pedido) => { pedidos.push(pedido); return travar },
  })
  baseWpp = `http://127.0.0.1:${await apiWpp.listen()}`
})

after(async () => { await apiWpp.close() })

const pedir = (corpo, token = 'segredo') => fetch(`${baseWpp}/wpp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(corpo),
})

test('wpp sem token é 401', async () => {
  assert.equal((await pedir({ request: 'oi' }, 'errado')).status, 401)
})

test('wpp aceita o pedido e o entrega inteiro', async () => {
  const r = await pedir({ request: 'responde o Fulano que a migração atrasou' })
  assert.equal(r.status, 202)
  assert.deepEqual(await r.json(), { ok: true, queued: true })
  assert.equal(pedidos.at(-1), 'responde o Fulano que a migração atrasou')
})

test('wpp sem request é 400', async () => {
  assert.equal((await pedir({ request: '   ' })).status, 400)
})

test('wpp com json inválido é 400', async () => {
  const r = await fetch(`${baseWpp}/wpp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: '{ nao e json',
  })
  assert.equal(r.status, 400)
})

test('GET em /wpp é 405', async () => {
  assert.equal((await fetch(`${baseWpp}/wpp`)).status, 405)
})

// Uma rodada do Claude leva o tempo que levar e responde no WhatsApp. Se a
// resposta HTTP esperasse por ela, todo pedido de verdade morreria em timeout.
test('wpp responde sem esperar a rodada terminar', async () => {
  travar = new Promise(() => {})
  const r = await pedir({ request: 'algo demorado' })
  assert.equal(r.status, 202)
  travar = null
})

test('sem conta pessoal ligada, /wpp responde 503 em vez de fingir', async () => {
  const semWpp = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp })
  const porta = await semWpp.listen()
  const r = await fetch(`http://127.0.0.1:${porta}/wpp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ request: 'oi' }),
  })
  assert.equal(r.status, 503)
  await semWpp.close()
})

async function subirComNotificador({ send }) {
  const alertas = []
  const notifier = createNotifier({
    send: send ?? (async (texto) => { alertas.push(texto) }),
    dedupMs: 60_000,
  })
  const servidor = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp, notifier })
  const porta = await servidor.listen()
  const notificar = (corpo, token = 'segredo') => fetch(`http://127.0.0.1:${porta}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(corpo),
  })
  return { servidor, notificar, alertas }
}

test('notify entrega ao dono com a origem marcada', async () => {
  const { servidor, notificar, alertas } = await subirComNotificador({})
  const r = await notificar({ text: 'disco em 91%', source: 'srv1' })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, sent: true, deduped: false })
  assert.deepEqual(alertas, ['🔔 [srv1] disco em 91%'])
  await servidor.close()
})

test('notify com a mesma key dentro da janela não repete', async () => {
  const { servidor, notificar, alertas } = await subirComNotificador({})
  await notificar({ text: 'CI quebrou', key: 'ci-main' })
  const r = await notificar({ text: 'CI quebrou', key: 'ci-main' })
  assert.deepEqual(await r.json(), { ok: true, sent: false, deduped: true })
  assert.equal(alertas.length, 1)
  await servidor.close()
})

test('notify exige token', async () => {
  const { servidor, notificar, alertas } = await subirComNotificador({})
  assert.equal((await notificar({ text: 'x' }, null)).status, 401)
  assert.equal((await notificar({ text: 'x' }, 'errado')).status, 401)
  assert.equal(alertas.length, 0)
  await servidor.close()
})

test('notify sem text, ou com text que não é string, é 400', async () => {
  const { servidor, notificar, alertas } = await subirComNotificador({})
  assert.equal((await notificar({ source: 'srv1' })).status, 400)
  assert.equal((await notificar({ text: '   ' })).status, 400)
  assert.equal((await notificar({ text: 42 })).status, 400)
  assert.equal(alertas.length, 0)
  await servidor.close()
})

test('notify com o whatsapp fora do ar é 502, não 200', async () => {
  const { servidor, notificar } = await subirComNotificador({ send: async () => { throw new Error('WhatsApp não está conectado') } })
  const r = await notificar({ text: 'x' })
  assert.equal(r.status, 502)
  assert.match((await r.json()).error, /não está conectado/)
  await servidor.close()
})

test('notify sem notificador configurado é 503', async () => {
  const r = await fetch(`${base}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ text: 'x' }),
  })
  assert.equal(r.status, 503)
})
