import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createCapture } from '../src/capture.js'
import { createRelay, lerTriagem, promptTriagem } from '../src/relay.js'

// A broadcast list and a forward both carry a contact's number without
// carrying a word written to the bot. Neither is a reply.
const DONO = '5511999999999'
const CONTATO = '5511911111111'

function montar({ triage } = {}) {
  const db = openDb(':memory:')
  createCapture({ db }).rememberChat({ jid: `${CONTATO}@s.whatsapp.net`, name: 'Luan', kind: 'dm' })
  const avisos = []
  const enviados = []
  const triagens = []
  const relay = createRelay({
    db,
    ownerNumber: DONO,
    notifyOwner: async (texto) => { avisos.push(texto); return `OWNER-${avisos.length}` },
    sendAsBot: async (jid, texto) => { enviados.push({ jid, texto }); relay.noteSent(jid, texto) },
    formalize: async () => 'x',
    triage: triage && (async (prompt) => { triagens.push(prompt); return triage(prompt) }),
    now: () => 1000,
    log: {},
  })
  relay.noteSent(`${CONTATO}@s.whatsapp.net`, 'Olá, Luan. Segue o convite.')
  const historico = () => db.prepare('select from_me, body from bot_messages where number = ? order by id').all(CONTATO)
  return { relay, avisos, enviados, triagens, historico }
}

test('lista de transmissão não é resposta: nada é respondido, avisado ou lembrado', async () => {
  const c = montar({ triage: async () => '{"acao":"responder","texto":"Que bom, aproveite!"}' })
  await c.relay.onOther({
    key: { remoteJid: '1234567890@broadcast', participant: `${CONTATO}@s.whatsapp.net`, broadcast: true, fromMe: false },
    kind: 'text',
    text: 'Um dia especial ao lado de pessoas especiais ❤️',
  })

  assert.deepEqual(c.enviados, [])
  assert.deepEqual(c.avisos, [])
  assert.equal(c.triagens.length, 0, 'nem chega a ser triada')
  assert.equal(c.historico().length, 1, 'só a mensagem que o bot mandou antes')
})

test('a marca broadcast na chave basta, mesmo com remoteJid de contato', async () => {
  const c = montar({ triage: async () => '{"acao":"responder","texto":"oi"}' })
  await c.relay.onOther({ key: { remoteJid: `${CONTATO}@s.whatsapp.net`, broadcast: true, fromMe: false }, kind: 'text', text: 'Meu amor 😍' })
  assert.deepEqual(c.enviados, [])
  assert.deepEqual(c.avisos, [])
})

test('encaminhamento que não pergunta nada é deixado de lado pela triagem', async () => {
  const c = montar({ triage: async () => '{"acao":"ignorar"}' })
  await c.relay.onOther({ key: { remoteJid: `${CONTATO}@s.whatsapp.net`, fromMe: false }, kind: 'image', text: 'Meu amor 😍', encaminhada: true })

  assert.deepEqual(c.enviados, [])
  assert.deepEqual(c.avisos, [])
  assert.match(c.triagens[0], /ENCAMINHADA de outra conversa/)
  assert.match(c.triagens[0], /\{"acao":"ignorar"\}/)
})

test('"ignorar" numa mensagem escrita para o bot não vale: o dono é avisado', async () => {
  const c = montar({ triage: async () => '{"acao":"ignorar"}' })
  await c.relay.onOther({ key: { remoteJid: `${CONTATO}@s.whatsapp.net`, fromMe: false }, kind: 'text', text: 'você vai na reunião?' })

  assert.deepEqual(c.enviados, [])
  assert.equal(c.avisos.length, 1)
  assert.match(c.avisos[0], /você vai na reunião\?/)
  assert.doesNotMatch(c.triagens[0], /ENCAMINHADA/)
  assert.doesNotMatch(c.triagens[0], /"acao":"ignorar"/)
})

test('encaminhamento com pedido dentro ainda pode ser respondido ou levado ao dono', async () => {
  const c = montar({ triage: async () => '{"acao":"responder","texto":"Vou verificar com o João e te retorno.","avisar":true,"motivo":"quer que o João confirme presença"}' })
  await c.relay.onOther({ key: { remoteJid: `${CONTATO}@s.whatsapp.net`, fromMe: false }, kind: 'text', text: 'Confirma presença até sexta?', encaminhada: true })

  assert.equal(c.enviados.length, 1)
  assert.equal(c.avisos.length, 1)
  assert.match(c.avisos[0], /📌 quer que o João confirme presença/)
})

test('lerTriagem reconhece ignorar', () => {
  assert.deepEqual(lerTriagem('{"acao":"ignorar"}'), { acao: 'ignorar' })
})

test('o prompt só oferece ignorar quando a mensagem veio encaminhada', () => {
  const normal = promptTriagem({ nome: 'Luan', historico: [], mensagem: 'oi' })
  const encaminhado = promptTriagem({ nome: 'Luan', historico: [], mensagem: 'oi', encaminhada: true })
  assert.doesNotMatch(normal, /"acao":"ignorar"/)
  assert.doesNotMatch(normal, /ENCAMINHADA/)
  assert.match(encaminhado, /trend/)
  assert.match(encaminhado, /nem responda, nem avise/)
})
