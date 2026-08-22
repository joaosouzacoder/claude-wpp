import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { loadConfig } from '../src/config.js'

function fixture(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(obj))
  return path
}

test('aplica os defaults quando o arquivo só traz o token', () => {
  const cfg = loadConfig({ path: fixture({ apiToken: 'abc' }), env: {} })
  assert.equal(cfg.apiToken, 'abc')
  assert.equal(cfg.authorizedNumber, '5511911111111')
  assert.equal(cfg.apiHost, '127.0.0.1')
  assert.equal(cfg.apiPort, 8787)
  assert.equal(cfg.slowNoticeMs, 8000)
  assert.equal(cfg.timeoutMs, 900000)
  assert.equal(cfg.maxMessageChars, 3500)
  assert.equal(cfg.claudeBin, 'claude')
  assert.equal(cfg.defaultCwd, homedir())
  assert.equal(cfg.stateDir, join(homedir(), '.local', 'state', 'claude-wpp'))
})

test('o arquivo sobrescreve os defaults', () => {
  const cfg = loadConfig({ path: fixture({ apiToken: 'abc', apiPort: 9999 }), env: {} })
  assert.equal(cfg.apiPort, 9999)
})

test('a variável de ambiente vence o arquivo', () => {
  const cfg = loadConfig({
    path: fixture({ apiToken: 'abc', apiPort: 9999 }),
    env: { CLAUDE_WPP_API_PORT: '7777', CLAUDE_WPP_API_TOKEN: 'do-env' },
  })
  assert.equal(cfg.apiPort, 7777)
  assert.equal(cfg.apiToken, 'do-env')
})

test('falha explicitamente quando não há token', () => {
  assert.throws(
    () => loadConfig({ path: fixture({}), env: {} }),
    /apiToken/,
  )
})

test('falha explicitamente quando o arquivo não existe', () => {
  assert.throws(
    () => loadConfig({ path: '/caminho/que/nao/existe.json', env: {} }),
    /config/i,
  )
})
