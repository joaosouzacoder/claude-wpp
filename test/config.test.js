import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { loadConfig } from '../src/config.js'

const MINIMO = { apiToken: 'abc', authorizedNumber: '5511911111111', botNumber: '5511922222222' }

function fixture(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(obj))
  return path
}

test('aplica os defaults quando o arquivo só traz o obrigatório', () => {
  const cfg = loadConfig({ path: fixture(MINIMO), env: {} })
  assert.equal(cfg.apiToken, 'abc')
  assert.equal(cfg.authorizedNumber, '5511911111111')
  assert.equal(cfg.apiHost, '127.0.0.1')
  assert.equal(cfg.apiPort, 8787)
  assert.equal(cfg.slowNoticeMs, 8000)
  assert.equal(cfg.timeoutMs, null, 'sem teto de tempo por padrão')
  assert.equal(cfg.maxMessageChars, 3500)
  assert.equal(cfg.claudeBin, 'claude')
  assert.equal(cfg.defaultCwd, homedir())
  assert.equal(cfg.stateDir, join(homedir(), '.local', 'state', 'claude-wpp'))
})

test('o arquivo sobrescreve os defaults', () => {
  const cfg = loadConfig({ path: fixture({ ...MINIMO, apiPort: 9999 }), env: {} })
  assert.equal(cfg.apiPort, 9999)
})

test('a variável de ambiente vence o arquivo', () => {
  const cfg = loadConfig({
    path: fixture({ ...MINIMO, apiPort: 9999 }),
    env: { CLAUDE_WPP_API_PORT: '7777', CLAUDE_WPP_API_TOKEN: 'do-env' },
  })
  assert.equal(cfg.apiPort, 7777)
  assert.equal(cfg.apiToken, 'do-env')
})

test('falha explicitamente quando não há token', () => {
  assert.throws(
    () => loadConfig({ path: fixture({ ...MINIMO, apiToken: null }), env: {} }),
    /apiToken/,
  )
})

test('falha explicitamente quando falta o número autorizado ou o do bot', () => {
  assert.throws(
    () => loadConfig({ path: fixture({ ...MINIMO, authorizedNumber: null }), env: {} }),
    /authorizedNumber/,
  )
  assert.throws(
    () => loadConfig({ path: fixture({ ...MINIMO, botNumber: null }), env: {} }),
    /botNumber/,
  )
})

test('falha explicitamente quando o arquivo não existe', () => {
  assert.throws(
    () => loadConfig({ path: '/caminho/que/nao/existe.json', env: {} }),
    /config/i,
  )
})

test('mídia tem defaults e mediaDir sai do stateDir', () => {
  const cfg = loadConfig({ path: fixture(MINIMO), env: {} })
  assert.equal(cfg.openaiApiKey, null)
  assert.equal(cfg.transcribeModel, 'gpt-4o-transcribe')
  assert.equal(cfg.transcribeTimeoutMs, 120000)
  assert.equal(cfg.mediaDir, join(cfg.stateDir, 'media'))
})

test('mediaDir acompanha um stateDir customizado', () => {
  const cfg = loadConfig({ path: fixture({ ...MINIMO, stateDir: '/var/claude-wpp' }), env: {} })
  assert.equal(cfg.mediaDir, join('/var/claude-wpp', 'media'))
})

test('mediaDir explícito no arquivo vence o derivado do stateDir', () => {
  const cfg = loadConfig({ path: fixture({ ...MINIMO, mediaDir: '/mnt/midia' }), env: {} })
  assert.equal(cfg.mediaDir, '/mnt/midia')
})

test('a chave da OpenAI pode vir do arquivo ou do ambiente', () => {
  const doArquivo = loadConfig({ path: fixture({ ...MINIMO, openaiApiKey: 'sk-arquivo' }), env: {} })
  assert.equal(doArquivo.openaiApiKey, 'sk-arquivo')

  const doEnv = loadConfig({
    path: fixture({ ...MINIMO, openaiApiKey: 'sk-arquivo' }),
    env: { OPENAI_API_KEY: 'sk-env' },
  })
  assert.equal(doEnv.openaiApiKey, 'sk-env')
})

test('a chave da OpenAI não é obrigatória: sem ela o serviço ainda sobe', () => {
  assert.doesNotThrow(() => loadConfig({ path: fixture(MINIMO), env: {} }))
})
