import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULTS = {
  apiHost: '127.0.0.1',
  apiPort: 8787,
  apiToken: null,
  stateDir: join(homedir(), '.local', 'state', 'claude-wpp'),
  claudeBin: 'claude',
  defaultCwd: homedir(),
  slowNoticeMs: 8000,
  timeoutMs: 900000,
  maxMessageChars: 3500,
}

const ENV_MAP = {
  CLAUDE_WPP_API_HOST: ['apiHost', String],
  CLAUDE_WPP_API_PORT: ['apiPort', Number],
  CLAUDE_WPP_API_TOKEN: ['apiToken', String],
  CLAUDE_WPP_STATE_DIR: ['stateDir', String],
  CLAUDE_WPP_CLAUDE_BIN: ['claudeBin', String],
  CLAUDE_WPP_DEFAULT_CWD: ['defaultCwd', String],
}

export function loadConfig({ path = join(homedir(), 'claude-wpp', 'config.json'), env = process.env } = {}) {
  let file
  try {
    file = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`Não consegui ler o config em ${path}: ${err.message}`)
  }

  const cfg = { ...DEFAULTS, ...file }

  for (const [key, [field, cast]] of Object.entries(ENV_MAP)) {
    if (env[key] != null && env[key] !== '') cfg[field] = cast(env[key])
  }

  for (const campo of ['apiToken', 'authorizedNumber', 'botNumber']) {
    if (!cfg[campo]) throw new Error(`config inválido: ${campo} é obrigatório`)
  }

  return cfg
}
