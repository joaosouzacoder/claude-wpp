import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { runClaude } from '../src/claude.js'

const BIN = fileURLToPath(new URL('./fake-claude.sh', import.meta.url))
const argsFile = () => join(mkdtempSync(join(tmpdir(), 'args-')), 'args.txt')

const base = { bin: BIN, cwd: tmpdir(), prompt: 'oi', slowNoticeMs: 50, timeoutMs: 5000 }

test('sessão nova não passa --resume e devolve o session_id', async () => {
  const file = argsFile()
  process.env.FAKE_ARGS_FILE = file
  process.env.FAKE_MODE = 'ok'
  const r = await runClaude({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'pronto')
  assert.equal(r.sessionId, 'sid-ok')

  const args = readFileSync(file, 'utf8').trim().split('\n')
  assert.deepEqual(args, ['-p', 'oi', '--output-format', 'json', '--dangerously-skip-permissions'])
})

test('sessão existente passa --resume com o id', async () => {
  const file = argsFile()
  process.env.FAKE_ARGS_FILE = file
  process.env.FAKE_MODE = 'ok'
  await runClaude({ ...base, sessionId: 'sid-antigo' })
  const args = readFileSync(file, 'utf8').trim().split('\n')
  assert.deepEqual(args.slice(-2), ['--resume', 'sid-antigo'])
})

test('dispara onSlow uma única vez quando demora', async () => {
  process.env.FAKE_MODE = 'slow'
  delete process.env.FAKE_ARGS_FILE
  let chamadas = 0
  const r = await runClaude({ ...base, onSlow: () => { chamadas += 1 } })
  assert.equal(chamadas, 1)
  assert.equal(r.ok, true)
})

test('não dispara onSlow quando responde rápido', async () => {
  process.env.FAKE_MODE = 'ok'
  let chamadas = 0
  await runClaude({ ...base, slowNoticeMs: 3000, onSlow: () => { chamadas += 1 } })
  assert.equal(chamadas, 0)
})

test('timeout mata o processo e devolve erro', async () => {
  process.env.FAKE_MODE = 'hang'
  const r = await runClaude({ ...base, timeoutMs: 150 })
  assert.equal(r.ok, false)
  assert.match(r.error, /tempo/i)
})

test('saída que não é json vira erro legível', async () => {
  process.env.FAKE_MODE = 'garbage'
  const r = await runClaude({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /resposta/i)
})

test('is_error do claude vira erro', async () => {
  process.env.FAKE_MODE = 'claude_error'
  const r = await runClaude({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /deu ruim/)
})

test('processo que morre com stderr vira erro com o stderr', async () => {
  process.env.FAKE_MODE = 'crash'
  const r = await runClaude({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
})

test('abort interrompe e devolve erro de cancelamento', async () => {
  process.env.FAKE_MODE = 'hang'
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 80)
  const r = await runClaude({ ...base, signal: ac.signal })
  assert.equal(r.ok, false)
  assert.match(r.error, /interrompid/i)
})

test('bin inexistente vira erro, não exceção', async () => {
  process.env.FAKE_MODE = 'ok'
  const r = await runClaude({ ...base, bin: '/nao/existe/claude' })
  assert.equal(r.ok, false)
  assert.ok(r.error.length > 0)
})

// O João não quer teto de tempo: uma tarefa longa não pode ser morta no meio só
// porque passou de um número. Sem teto, quem interrompe é o /stop.
test('sem timeoutMs configurado, não existe teto: a execução longa termina', async () => {
  process.env.FAKE_MODE = 'slow'
  const r = await runClaude({ ...base, timeoutMs: null, slowNoticeMs: 10 })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'demorei')
})

test('teto zero também significa sem teto, não matar na hora', async () => {
  process.env.FAKE_MODE = 'slow'
  const r = await runClaude({ ...base, timeoutMs: 0 })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'demorei')
})

test('sem teto, o abort continua sendo a forma de interromper', async () => {
  process.env.FAKE_MODE = 'hang'
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 100)
  const r = await runClaude({ ...base, timeoutMs: null, signal: ac.signal })
  assert.equal(r.ok, false)
  assert.match(r.error, /interrompid/i)
})
