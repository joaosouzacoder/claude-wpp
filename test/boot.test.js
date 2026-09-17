import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { contaPessoalPareada, montarContaPessoal } from '../src/boot.js'

// index.js runs main() the instant it is imported, so these two wiring
// functions live in their own module specifically to be testable without
// that happening — see the comment at the top of src/boot.js.

function dirTemp() {
  return mkdtempSync(join(tmpdir(), 'boot-'))
}

function credenciaisValidas(dir) {
  writeFileSync(join(dir, 'creds.json'), JSON.stringify({
    me: { id: '5511911111111:3@s.whatsapp.net' },
    account: { details: 'x', accountSignature: 'y', deviceSignature: 'z' },
  }))
}

test('contaPessoalPareada é falso sem personalNumber configurado', () => {
  assert.equal(contaPessoalPareada({ personalNumber: null, personalAuthDir: dirTemp() }), false)
})

test('contaPessoalPareada é falso com personalNumber mas sem parear', () => {
  assert.equal(contaPessoalPareada({ personalNumber: '5511911111111', personalAuthDir: dirTemp() }), false)
})

test('contaPessoalPareada é verdadeiro só quando as duas condições batem', () => {
  const dir = dirTemp()
  credenciaisValidas(dir)
  assert.equal(contaPessoalPareada({ personalNumber: '5511911111111', personalAuthDir: dir }), true)
})

function configBase() {
  const stateDir = dirTemp()
  return {
    dbPath: ':memory:',
    personalAuthDir: join(stateDir, 'wa-auth-me'),
    claudeBin: 'claude',
    agentCwd: join(stateDir, 'agent'),
    timeoutMs: null,
    timezone: 'America/Sao_Paulo',
    scheduleToleranceSec: 3600,
    schedulerIntervalMs: 30000,
  }
}

const logMudo = { info() {}, warn() {}, error() {}, debug() {} }

test('montarContaPessoal monta as cinco peças (db, me, outbox, wpp, scheduler)', () => {
  const pessoal = montarContaPessoal(configBase(), async () => {}, logMudo)
  try {
    assert.ok(pessoal.db)
    assert.ok(pessoal.me)
    assert.ok(pessoal.outbox)
    assert.ok(pessoal.wpp)
    assert.ok(pessoal.scheduler)
  } finally {
    pessoal.db.close()
  }
})

test('o outbox montado é funcional (grava e lê de volta)', () => {
  const pessoal = montarContaPessoal(configBase(), async () => {}, logMudo)
  try {
    const job = pessoal.outbox.create({ chatJid: '5@s.whatsapp.net', chatName: 'Jane', body: 'oi' })
    assert.equal(pessoal.outbox.get(job.id).body, 'oi')
  } finally {
    pessoal.db.close()
  }
})

test('o scheduler montado usa o outbox e o notify certos (start/stop não quebram)', () => {
  const pessoal = montarContaPessoal(configBase(), async () => {}, logMudo)
  try {
    assert.doesNotThrow(() => pessoal.scheduler.start())
    assert.doesNotThrow(() => pessoal.scheduler.stop())
  } finally {
    pessoal.db.close()
  }
})
