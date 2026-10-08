import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { readLastTurnEnd, readLastReply, transcriptPath } from '../src/transcript.js'

// The shape Claude Code writes at the end of a turn, taken from a real
// transcript: the final assistant text, bookkeeping attachments, then the
// `system` entries `stop_hook_summary` and `turn_duration`.
function escrever(linhas) {
  const home = mkdtempSync(join(tmpdir(), 'turn-end-'))
  const cwd = '/home/user/projeto'
  const caminho = transcriptPath(cwd, 'sid-1', { home })
  mkdirSync(dirname(caminho), { recursive: true })
  writeFileSync(caminho, linhas.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n')
  return { cwd, home }
}

const assistant = (texto, timestamp) => ({ type: 'assistant', timestamp, message: { content: [{ type: 'text', text: texto }] } })
const fimDeTurno = (timestamp) => ({ type: 'system', subtype: 'turn_duration', durationMs: 4000, timestamp })

test('acha o fim do último turno, depois da resposta final', async () => {
  const { cwd, home } = escrever([
    { type: 'user', timestamp: '2026-10-08T05:15:57.000Z', message: { content: 'pedido' } },
    assistant('Passei para a sessão infra.', '2026-10-08T05:16:56.000Z'),
    { type: 'attachment', timestamp: '2026-10-08T05:17:00.000Z' },
    { type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-10-08T05:17:00.100Z' },
    fimDeTurno('2026-10-08T05:17:00.200Z'),
  ])
  assert.deepEqual(await readLastTurnEnd({ cwd, sessionId: 'sid-1', home }), { timestamp: '2026-10-08T05:17:00.200Z' })
  assert.equal((await readLastReply({ cwd, sessionId: 'sid-1', home })).content, 'Passei para a sessão infra.')
})

test('turno ainda aberto: o último fim é o do turno anterior, não um novo', async () => {
  const { cwd, home } = escrever([
    assistant('resposta de antes', '2026-10-08T04:00:00.000Z'),
    fimDeTurno('2026-10-08T04:00:01.000Z'),
    { type: 'user', timestamp: '2026-10-08T05:15:57.000Z', message: { content: 'pedido' } },
    assistant('Vou pedir ao swat.', '2026-10-08T05:16:10.000Z'),
    { type: 'assistant', timestamp: '2026-10-08T05:16:12.000Z', message: { content: [{ type: 'tool_use', name: 'Agent', input: {} }] } },
  ])
  assert.deepEqual(await readLastTurnEnd({ cwd, sessionId: 'sid-1', home }), { timestamp: '2026-10-08T04:00:01.000Z' })
})

test('linha quebrada no meio não derruba a leitura, e sem fim de turno devolve null', async () => {
  const { cwd, home } = escrever([
    assistant('oi', '2026-10-08T05:16:10.000Z'),
    '{"type":"system","subtype":"turn_duration","timestamp":"2026-10-08T05:16:1',
  ])
  assert.equal(await readLastTurnEnd({ cwd, sessionId: 'sid-1', home }), null)
  assert.equal(await readLastTurnEnd({ cwd: '/nao/existe', sessionId: 'x', home }), null)
})
