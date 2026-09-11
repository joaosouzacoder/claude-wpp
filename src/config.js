import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULTS = {
  apiHost: '127.0.0.1',
  apiPort: 8787,
  apiToken: null,
  stateDir: join(homedir(), '.local', 'state', 'claude-wpp'),
  claudeBin: 'claude',
  // When this binary answers, sessions live in agent-deck; otherwise the bot
  // keeps its own headless sessions, exactly as before agent-deck existed.
  agentDeckBin: 'agent-deck',
  notifyIntervalMs: 5000,
  defaultCwd: homedir(),
  slowNoticeMs: 8000,
  heartbeatMs: 300000,
  timeoutMs: null,
  maxMessageChars: 3500,
  openaiApiKey: null,
  transcribeModel: 'gpt-4o-transcribe',
  transcribeTimeoutMs: 120000,
  personalNumber: null,
  timezone: 'America/Sao_Paulo',
  schedulerIntervalMs: 30000,
  scheduleToleranceSec: 3600,
}

const ENV_MAP = {
  CLAUDE_WPP_API_HOST: ['apiHost', String],
  CLAUDE_WPP_API_PORT: ['apiPort', Number],
  // Keeping the token out of config.json means it can live wherever the secrets
  // already live, and the file on disk stops being worth protecting on its own.
  // Both names read the same field: the short one is what a shared secrets file
  // tends to be keyed by, and it is applied last so it wins a disagreement.
  CLAUDE_WPP_API_TOKEN: ['apiToken', String],
  WPP_TOKEN: ['apiToken', String],
  CLAUDE_WPP_STATE_DIR: ['stateDir', String],
  CLAUDE_WPP_CLAUDE_BIN: ['claudeBin', String],
  CLAUDE_WPP_AGENT_DECK_BIN: ['agentDeckBin', String],
  CLAUDE_WPP_DEFAULT_CWD: ['defaultCwd', String],
  OPENAI_API_KEY: ['openaiApiKey', String],
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

  // Derived after the overrides, so they follow whoever moves the stateDir.
  cfg.mediaDir ??= join(cfg.stateDir, 'media')
  cfg.botAuthDir ??= join(cfg.stateDir, 'wa-auth')
  cfg.personalAuthDir ??= join(cfg.stateDir, 'wa-auth-me')
  cfg.dbPath ??= join(cfg.stateDir, 'wpp.db')

  // The session that answers /wpp works here: its CLAUDE.md is what teaches it
  // to read the log and to propose instead of sending.
  cfg.agentCwd ??= join(dirname(path), 'agent')

  return cfg
}
