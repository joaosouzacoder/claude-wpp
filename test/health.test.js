import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { lerSaude, avaliar, checar } from '../src/health.js'

const SAUDAVEL = { saudavel: true, motivo: null }
const DOENTE = { saudavel: false, motivo: 'WhatsApp do bot está "closed"' }

test('lerSaude: só wa open é saudável', () => {
  assert.deepEqual(lerSaude({ ok: true, status: 200, corpo: { wa: 'open' } }), SAUDAVEL)
  assert.equal(lerSaude({ ok: true, status: 200, corpo: { wa: 'connecting' } }).saudavel, false)
  assert.match(lerSaude({ erro: 'timeout' }).motivo, /não respondeu \(timeout\)/)
  assert.match(lerSaude({ ok: false, status: 502 }).motivo, /HTTP 502/)
})

test('uma falha isolada (reconexão) não alerta', () => {
  const { estado, alerta } = avaliar({}, DOENTE, 0)
  assert.equal(alerta, null)
  assert.equal(estado.falhas, 1)
})

test('a segunda falha seguida alerta, uma vez só', () => {
  let { estado } = avaliar({}, DOENTE, 0)
  const segunda = avaliar(estado, DOENTE, 120_000)
  assert.equal(segunda.alerta.titulo, 'claude-wpp fora do ar')
  assert.equal(segunda.alerta.prioridade, 'high')
  assert.match(segunda.alerta.mensagem, /closed/)
  estado = segunda.estado
  for (let i = 0; i < 5; i += 1) {
    const r = avaliar(estado, DOENTE, 240_000 + i)
    assert.equal(r.alerta, null, 'não repete a cada checagem')
    estado = r.estado
  }
})

test('voltar depois de alertado avisa que voltou; voltar sem ter alertado fica quieto', () => {
  const alertado = { falhas: 3, alertado: true, desde: '2026-09-21T03:00:00.000Z' }
  const r = avaliar(alertado, SAUDAVEL, 0)
  assert.equal(r.alerta.titulo, 'claude-wpp voltou')
  assert.match(r.alerta.mensagem, /2026-09-21T03:00:00/)
  assert.deepEqual(r.estado, { falhas: 0, alertado: false, desde: null })

  assert.equal(avaliar({ falhas: 1, alertado: false }, SAUDAVEL, 0).alerta, null)
})

function fetchFalso({ healthz, ntfyFalha = false }) {
  const ntfy = []
  const fetcher = async (url, opts = {}) => {
    if (url.endsWith('/healthz')) {
      if (healthz instanceof Error) throw healthz
      return { ok: true, status: 200, json: async () => healthz }
    }
    ntfy.push({ url, ...opts })
    return { ok: !ntfyFalha, status: ntfyFalha ? 500 : 200 }
  }
  return { fetcher, ntfy }
}

test('checar: duas quedas seguidas mandam um ntfy com título e prioridade', async () => {
  const estadoPath = join(mkdtempSync(join(tmpdir(), 'health-')), 'health.json')
  const { fetcher, ntfy } = fetchFalso({ healthz: new Error('connect ECONNREFUSED') })
  await checar({ healthzUrl: 'http://127.0.0.1:1/healthz', topico: 'meu-topico', estadoPath, fetcher, log: {} })
  assert.equal(ntfy.length, 0)
  await checar({ healthzUrl: 'http://127.0.0.1:1/healthz', topico: 'meu-topico', estadoPath, fetcher, log: {} })
  assert.equal(ntfy.length, 1)
  assert.equal(ntfy[0].url, 'https://ntfy.sh/meu-topico')
  assert.equal(ntfy[0].headers.Title, 'claude-wpp fora do ar')
  assert.equal(ntfy[0].headers.Priority, 'high')
  assert.match(ntfy[0].body, /ECONNREFUSED/)
})

test('checar: ntfy falhando não grava o estado, e a próxima checagem tenta de novo', async () => {
  const estadoPath = join(mkdtempSync(join(tmpdir(), 'health-')), 'health.json')
  writeFileSync(estadoPath, JSON.stringify({ falhas: 1, alertado: false, desde: '2026-09-21T03:00:00.000Z' }))
  const falho = fetchFalso({ healthz: { wa: 'closed' }, ntfyFalha: true })
  await assert.rejects(checar({ healthzUrl: 'http://x/healthz', topico: 't', estadoPath, fetcher: falho.fetcher, log: {} }), /HTTP 500/)
  assert.equal(JSON.parse(readFileSync(estadoPath, 'utf8')).alertado, false, 'o alerta não foi entregue, então não conta')

  const ok = fetchFalso({ healthz: { wa: 'closed' } })
  await checar({ healthzUrl: 'http://x/healthz', topico: 't', estadoPath, fetcher: ok.fetcher, log: {} })
  assert.equal(ok.ntfy.length, 1)
})
