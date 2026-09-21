import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../src/db.js'
import { createCapture } from '../src/capture.js'
import { createContactResolver, normalizarNome, pareceNumero } from '../src/contacts.js'

// Chats go in the way production records them, through capture.
function montar(chats) {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'contatos-')), 'wpp.db'))
  const capture = createCapture({ db })
  for (const c of chats) capture.rememberChat(c)
  return createContactResolver(db)
}

// Placeholder numbers only (CONTRIBUTING.md): CI rejects any other.
const AGENDA = [
  { jid: '5511911111111@s.whatsapp.net', name: 'Fulano Bailāo', kind: 'dm' },
  { jid: '5511922222222@s.whatsapp.net', name: 'Fulano Peters Martins', kind: 'dm' },
  { jid: '5521911111111@s.whatsapp.net', name: 'Maria Silva', kind: 'dm' },
  { jid: '120363000000000000@g.us', name: 'Time de Plataforma', kind: 'group' },
]

test('nome digitado com acento diferente acha o contato gravado', () => {
  const r = montar(AGENDA).resolve('fulano bailão')
  assert.deepEqual(r, { ok: true, jid: '5511911111111@s.whatsapp.net', name: 'Fulano Bailāo' })
})

test('parte do nome basta quando só um contato bate', () => {
  assert.equal(montar(AGENDA).resolve('maria').jid, '5521911111111@s.whatsapp.net')
  assert.equal(montar(AGENDA).resolve('peters').jid, '5511922222222@s.whatsapp.net')
})

test('grupo também resolve pelo nome', () => {
  assert.equal(montar(AGENDA).resolve('time de plataforma').jid, '120363000000000000@g.us')
})

test('mais de um candidato não chuta: devolve os nomes', () => {
  const r = montar(AGENDA).resolve('Fulano')
  assert.equal(r.ok, false)
  assert.equal(r.motivo, 'ambiguo')
  assert.deepEqual(r.candidatos.sort(), ['Fulano Bailāo', 'Fulano Peters Martins'])
})

test('nome exato vence mesmo quando também é parte de outro', () => {
  const r = montar([
    { jid: 'a@s.whatsapp.net', name: 'Ana', kind: 'dm' },
    { jid: 'b@s.whatsapp.net', name: 'Ana Paula', kind: 'dm' },
  ]).resolve('ana')
  assert.equal(r.jid, 'a@s.whatsapp.net')
})

test('ninguém com esse nome', () => {
  assert.deepEqual(montar(AGENDA).resolve('Beltrano'), { ok: false, motivo: 'nenhum', candidatos: [] })
})

test('normalizarNome e pareceNumero', () => {
  assert.equal(normalizarNome('  Fulano   BAILĀO '), 'fulano bailao')
  assert.equal(pareceNumero('5511911111111'), true)
  assert.equal(pareceNumero('+55 (11) 91111-1111'), true)
  assert.equal(pareceNumero('123@g.us'), true)
  assert.equal(pareceNumero('Fulano Bailão'), false)
  assert.equal(pareceNumero('12345'), false)
})
