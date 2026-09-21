import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { transcriptPath, readLastReply } from '../src/transcript.js'

function ambiente() {
  return mkdtempSync(join(tmpdir(), 'transcript-'))
}

function linha(obj) {
  return `${JSON.stringify(obj)}\n`
}

test('transcriptPath troca cada caractere não alfanumérico do cwd por hífen', () => {
  const p = transcriptPath('/home/user/.claude/proj', 'sid-1', { home: '/home/user' })
  assert.equal(p, '/home/user/.claude/projects/-home-user--claude-proj/sid-1.jsonl')
})

test('devolve o último texto do assistente com o timestamp gravado', async () => {
  const home = ambiente()
  const dir = join(home, '.claude', 'projects', '-tmp-projeto')
  mkdirSync(dir, { recursive: true })
  const arquivo = join(dir, 'sid-1.jsonl')
  writeFileSync(arquivo, [
    linha({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'oi' }] } }),
    linha({ type: 'assistant', timestamp: '2026-01-01T10:00:00.000Z', message: { content: [{ type: 'text', text: 'primeira' }] } }),
    linha({ type: 'assistant', timestamp: '2026-01-01T10:00:05.000Z', message: { content: [{ type: 'text', text: 'segunda' }] } }),
    linha({ type: 'cost-state' }),
  ].join(''))

  const r = await readLastReply({ cwd: '/tmp/projeto', sessionId: 'sid-1', home })
  assert.deepEqual(r, { content: 'segunda', timestamp: '2026-01-01T10:00:05.000Z' })
})

test('junta múltiplos blocos de texto do mesmo turno', async () => {
  const home = ambiente()
  const dir = join(home, '.claude', 'projects', '-tmp-projeto')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sid-1.jsonl'), linha({
    type: 'assistant',
    timestamp: '2026-01-01T10:00:00.000Z',
    message: { content: [{ type: 'text', text: 'parte 1. ' }, { type: 'tool_use' }, { type: 'text', text: 'parte 2.' }] },
  }))

  const r = await readLastReply({ cwd: '/tmp/projeto', sessionId: 'sid-1', home })
  assert.equal(r.content, 'parte 1. parte 2.')
})

test('turno que só chamou ferramenta (sem texto) não conta como resposta', async () => {
  const home = ambiente()
  const dir = join(home, '.claude', 'projects', '-tmp-projeto')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sid-1.jsonl'), [
    linha({ type: 'assistant', timestamp: '2026-01-01T10:00:00.000Z', message: { content: [{ type: 'text', text: 'anterior' }] } }),
    linha({ type: 'assistant', timestamp: '2026-01-01T10:00:05.000Z', message: { content: [{ type: 'tool_use' }] } }),
  ].join(''))

  const r = await readLastReply({ cwd: '/tmp/projeto', sessionId: 'sid-1', home })
  assert.equal(r.content, 'anterior')
})

test('arquivo inexistente devolve null em vez de lançar', async () => {
  const home = ambiente()
  assert.equal(await readLastReply({ cwd: '/nunca/existiu', sessionId: 'sid-1', home }), null)
})

test('sem sessionId ou cwd devolve null', async () => {
  assert.equal(await readLastReply({ cwd: '/tmp/x', sessionId: null }), null)
  assert.equal(await readLastReply({ cwd: null, sessionId: 'sid-1' }), null)
})

test('linha corrompida no meio do arquivo não impede achar a resposta boa', async () => {
  const home = ambiente()
  const dir = join(home, '.claude', 'projects', '-tmp-projeto')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'sid-1.jsonl'), [
    linha({ type: 'assistant', timestamp: '2026-01-01T10:00:00.000Z', message: { content: [{ type: 'text', text: 'boa' }] } }),
    'isso não é json\n',
  ].join(''))

  const r = await readLastReply({ cwd: '/tmp/projeto', sessionId: 'sid-1', home })
  assert.equal(r.content, 'boa')
})
