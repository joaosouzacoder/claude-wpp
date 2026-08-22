import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../src/api.js'

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
