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

// Tirar o token do config.json é o que permite guardá-lo junto dos outros
// segredos da máquina; o arquivo no disco deixa de valer alguma coisa sozinho.
test('WPP_TOKEN do ambiente serve de token, sem nada no arquivo', () => {
  const { apiToken, ...semToken } = MINIMO
  const cfg = loadConfig({ path: fixture(semToken), env: { WPP_TOKEN: 'do-tokens' } })
  assert.equal(cfg.apiToken, 'do-tokens')
})

test('sem token no arquivo e sem token no ambiente, falha em vez de subir aberto', () => {
  const { apiToken, ...semToken } = MINIMO
  assert.throws(() => loadConfig({ path: fixture(semToken), env: {} }), /apiToken/)
})

// config.example.json é público e commitado — copiá-lo sem trocar o token
// deixaria a API aberta sob um valor que qualquer um que já viu o repositório
// conhece.
test('recusa o token exatamente igual ao do config.example.json', () => {
  assert.throws(
    () => loadConfig({ path: fixture({ ...MINIMO, apiToken: 'troque-por-um-token-forte' }), env: {} }),
    /exemplo/i,
  )
})

test('um token parecido mas diferente do exemplo passa normalmente', () => {
  const cfg = loadConfig({ path: fixture({ ...MINIMO, apiToken: 'troque-por-um-token-forte-de-verdade' }), env: {} })
  assert.equal(cfg.apiToken, 'troque-por-um-token-forte-de-verdade')
})

test('campo numérico inválido no arquivo cai no padrão em vez de propagar lixo', () => {
  const avisos = []
  const log = { warn: (m) => avisos.push(m) }
  const cfg = loadConfig({ path: fixture({ ...MINIMO, apiPort: 'oito mil' }), env: {}, log })
  assert.equal(cfg.apiPort, 8787)
  assert.match(avisos.join('\n'), /apiPort/)
})

test('timeoutMs nulo continua significando "sem teto", não é tratado como inválido', () => {
  const avisos = []
  const log = { warn: (m) => avisos.push(m) }
  const cfg = loadConfig({ path: fixture({ ...MINIMO, timeoutMs: null }), env: {}, log })
  assert.equal(cfg.timeoutMs, null)
  assert.deepEqual(avisos, [])
})

test('timeoutMs com número de verdade continua funcionando', () => {
  const cfg = loadConfig({ path: fixture({ ...MINIMO, timeoutMs: 5000 }), env: {} })
  assert.equal(cfg.timeoutMs, 5000)
})

test('campos com default nulo mas não numéricos (apiToken, openaiApiKey, personalNumber) não são mexidos pela validação numérica', () => {
  const cfg = loadConfig({ path: fixture({ ...MINIMO, openaiApiKey: 'sk-abc', personalNumber: '5511999999999' }), env: {} })
  assert.equal(cfg.apiToken, 'abc')
  assert.equal(cfg.openaiApiKey, 'sk-abc')
  assert.equal(cfg.personalNumber, '5511999999999')
})

test('NaN vindo de uma env var também cai no padrão', () => {
  const avisos = []
  const log = { warn: (m) => avisos.push(m) }
  const cfg = loadConfig({ path: fixture(MINIMO), env: { CLAUDE_WPP_API_PORT: 'nao-e-numero' }, log })
  assert.equal(cfg.apiPort, 8787)
  assert.match(avisos.join('\n'), /apiPort/)
})
