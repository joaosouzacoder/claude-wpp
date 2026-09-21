import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createCapture } from '../src/capture.js'
import { createRelay, limparFormal } from '../src/relay.js'

const DONO = '5511999999999'
const CONTATO = '5511911111111'
const ESTRANHO = '5511922222222'

function montar({ formalize } = {}) {
  const db = openDb(':memory:')
  createCapture({ db }).rememberChat({ jid: `${CONTATO}@s.whatsapp.net`, name: 'Fulano Bailāo', kind: 'dm' })
  const avisos = []
  const enviados = []
  const prompts = []
  let proximoId = 1
  const relay = createRelay({
    db,
    ownerNumber: DONO,
    notifyOwner: async (texto) => { avisos.push(texto); return `OWNER-${proximoId++}` },
    sendAsBot: async (jid, texto) => { enviados.push({ jid, texto }) },
    formalize: formalize ?? (async (prompt) => { prompts.push(prompt); return '"Olá, Fulano. Amanhã às 10h está confirmado."' }),
    now: () => 1000,
    log: {},
  })
  return { relay, avisos, enviados, prompts }
}

const chave = (numero) => ({ remoteJid: `${numero}@s.whatsapp.net`, fromMe: false })

test('resposta de quem o bot nunca escreveu é ignorada', async () => {
  const { relay, avisos } = montar()
  await relay.onOther({ key: chave(ESTRANHO), kind: 'text', text: 'oi, quem é?' })
  assert.deepEqual(avisos, [])
})

test('resposta de quem o bot escreveu chega ao dono, com nome, texto e como responder', async () => {
  const { relay, avisos } = montar()
  relay.noteSent(`${CONTATO}@s.whatsapp.net`)
  await relay.onOther({ key: chave(CONTATO), kind: 'text', text: 'pode ser amanhã às 10?' })
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /Fulano Bailāo respondeu \(#1\)/)
  assert.match(avisos[0], /pode ser amanhã às 10\?/)
  assert.match(avisos[0], /citando esta mensagem/)
  assert.equal(relay.porCitacao('OWNER-1').from_number, CONTATO, 'citar o aviso acha quem mandou')
})

test('remetente só em @lid, sem o número junto, não é repassado', async () => {
  const { relay, avisos } = montar()
  relay.noteSent(CONTATO)
  await relay.onOther({ key: { remoteJid: '123456789@lid', fromMe: false }, kind: 'text', text: 'oi' })
  assert.deepEqual(avisos, [])
})

test('@lid acompanhado do número real é repassado', async () => {
  const { relay, avisos } = montar()
  relay.noteSent(CONTATO)
  await relay.onOther({ key: { remoteJid: '123456789@lid', remoteJidAlt: `${CONTATO}@s.whatsapp.net`, fromMe: false }, kind: 'text', text: 'oi' })
  assert.equal(avisos.length, 1)
})

test('grupo nunca é repassado, nem o próprio dono vira contato do bot', async () => {
  const { relay, avisos } = montar()
  relay.noteSent('120363000000000000@g.us')
  relay.noteSent(DONO)
  await relay.onOther({ key: { remoteJid: '120363000000000000@g.us', participant: `${CONTATO}@s.whatsapp.net` }, kind: 'text', text: 'oi' })
  await relay.onOther({ key: chave(DONO), kind: 'text', text: 'oi' })
  assert.deepEqual(avisos, [])
})

test('mídia sem texto chega descrita', async () => {
  const { relay, avisos } = montar()
  relay.noteSent(CONTATO)
  await relay.onOther({ key: chave(CONTATO), kind: 'image', text: '' })
  assert.match(avisos[0], /mandou uma imagem/)
})

test('a resposta do dono é formalizada com o contexto e sai pelo bot para quem mandou', async () => {
  const { relay, enviados, prompts } = montar()
  relay.noteSent(CONTATO)
  await relay.onOther({ key: chave(CONTATO), kind: 'text', text: 'pode ser amanhã às 10?' })
  const r = await relay.answer(relay.porNumero(1), 'fechado, 10h')

  assert.deepEqual(r, { ok: true, to: 'Fulano Bailāo', text: 'Olá, Fulano. Amanhã às 10h está confirmado.' })
  assert.deepEqual(enviados, [{ jid: `${CONTATO}@s.whatsapp.net`, texto: 'Olá, Fulano. Amanhã às 10h está confirmado.' }])
  assert.match(prompts[0], /formal/)
  assert.match(prompts[0], /pode ser amanhã às 10\?/)
  assert.match(prompts[0], /fechado, 10h/)
})

test('formalização que falha não manda o texto cru', async () => {
  const { relay, enviados } = montar({ formalize: async () => { throw new Error('claude fora do ar') } })
  relay.noteSent(CONTATO)
  await relay.onOther({ key: chave(CONTATO), kind: 'text', text: 'oi' })
  const r = await relay.answer(relay.porNumero(1), 'fechado')
  assert.equal(r.ok, false)
  assert.match(r.error, /não mandei nada/)
  assert.deepEqual(enviados, [])
})

test('versão formal vazia também não manda nada', async () => {
  const { relay, enviados } = montar({ formalize: async () => '  ""  ' })
  relay.noteSent(CONTATO)
  await relay.onOther({ key: chave(CONTATO), kind: 'text', text: 'oi' })
  assert.equal((await relay.answer(relay.porNumero(1), 'ok')).ok, false)
  assert.deepEqual(enviados, [])
})

test('limparFormal tira aspas que envolvem a resposta inteira', () => {
  assert.equal(limparFormal('“Olá.”'), 'Olá.')
  assert.equal(limparFormal('Ele disse "ok".'), 'Ele disse "ok".')
})
