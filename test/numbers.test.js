import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeNumber, sameNumber, senderNumber } from '../src/numbers.js'

test('normalizeNumber tira sufixo de jid, device e pontuação', () => {
  assert.equal(normalizeNumber('5511911111111@s.whatsapp.net'), '5511911111111')
  assert.equal(normalizeNumber('5511911111111:12@s.whatsapp.net'), '5511911111111')
  assert.equal(normalizeNumber('+55 (11) 91111-1111'), '5511911111111')
})

test('sameNumber compara números idênticos', () => {
  assert.ok(sameNumber('5511911111111@s.whatsapp.net', '5511911111111'))
})

test('sameNumber tolera a ausência do nono dígito', () => {
  assert.ok(sameNumber('551111111111@s.whatsapp.net', '5511911111111'))
  assert.ok(sameNumber('5511911111111', '551111111111'))
})

test('sameNumber recusa números diferentes', () => {
  assert.equal(sameNumber('5511999999999', '5511911111111'), false)
  assert.equal(sameNumber('', '5511911111111'), false)
  assert.equal(sameNumber(null, '5511911111111'), false)
})

test('sameNumber não confunde DDDs diferentes', () => {
  assert.equal(sameNumber('5521911111111', '5511911111111'), false)
})

test('senderNumber prefere o telefone quando o remoteJid é um lid', () => {
  assert.equal(
    senderNumber({ remoteJid: '123456789@lid', senderPn: '5511911111111@s.whatsapp.net' }),
    '5511911111111',
  )
  assert.equal(
    senderNumber({ remoteJid: '123456789@lid', remoteJidAlt: '5511911111111@s.whatsapp.net' }),
    '5511911111111',
  )
})

test('senderNumber devolve null quando só existe lid', () => {
  assert.equal(senderNumber({ remoteJid: '123456789@lid' }), null)
})

test('senderNumber usa o remoteJid comum', () => {
  assert.equal(senderNumber({ remoteJid: '5511911111111@s.whatsapp.net' }), '5511911111111')
})
