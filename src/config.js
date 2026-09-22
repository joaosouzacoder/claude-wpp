import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const DEFAULTS = {
  apiHost: '127.0.0.1',
  apiPort: 8787,
  apiToken: null,
  stateDir: join(homedir(), '.local', 'state', 'claude-wpp'),
  claudeBin: 'claude',
  defaultCwd: homedir(),
  slowNoticeMs: 8000,
  heartbeatMs: 300000,
  timeoutMs: null,
  // Unlike timeoutMs, this one has no null/unlimited mode: `blocked` is a
  // known claude bug with no way out on its own, so waiting forever on it is
  // never the right default (see the comment above BLOQUEIO_TIMEOUT_MS).
  blockedTimeoutMs: 20 * 60 * 1000,
  maxMessageChars: 3500,
  // Past this, a reply arrives as a preview plus a .txt attachment instead of
  // a run of message bubbles: two full bubbles is where reading on a phone
  // stops working.
  attachAboveChars: 7000,
  // POST /notify with a `key`: repeats of that key inside this window are
  // dropped, so a check that fails every minute pings once, not sixty times.
  notifyDedupMs: 10 * 60 * 1000,
  // ntfy.sh topic the health check alerts on when the bot itself is down
  // (WhatsApp cannot report its own outage). Unset, the check does nothing.
  ntfyTopic: null,
  openaiApiKey: null,
  transcribeModel: 'gpt-4o-transcribe',
  transcribeTimeoutMs: 120000,
  // Reads plain words as a bot command ("manda o 3 pelo bot"). Past the
  // timeout the text simply goes on to the session.
  intentModel: 'haiku',
  intentTimeoutMs: 60000,
  // Deciding whether a message someone sent the bot needs the owner, and
  // writing the small talk that does not. Failure or timeout means "tell the
  // owner", so this one can afford to be the better model.
  triageModel: 'sonnet',
  triageTimeoutMs: 3 * 60 * 1000,
  personalNumber: null,
  timezone: 'America/Sao_Paulo',
  schedulerIntervalMs: 30000,
  scheduleToleranceSec: 3600,
  // Images are kept on disk on purpose (README: Claude can revisit one from
  // earlier in the conversation) and never deleted on their own otherwise —
  // this is the automatic backstop against unbounded growth.
  mediaMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
}

// Must match config.example.json's apiToken verbatim: copying that file to
// config.json without changing it would otherwise leave the API open under a
// token that is public, committed, and identical on every install.
const TOKEN_DE_EXEMPLO = 'troque-por-um-token-forte'

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
  CLAUDE_WPP_DEFAULT_CWD: ['defaultCwd', String],
  OPENAI_API_KEY: ['openaiApiKey', String],
}

export function loadConfig({ path = join(homedir(), 'claude-wpp', 'config.json'), env = process.env, log = console } = {}) {
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

  if (cfg.apiToken === TOKEN_DE_EXEMPLO) {
    throw new Error('config inválido: apiToken ainda é o valor de exemplo do config.example.json — troque por um token de verdade antes de subir o serviço.')
  }

  // Whatever JSON.parse produced going straight into things like setTimeout
  // delays or SQL LIMIT counts is how a typo in config.json becomes a
  // silent NaN somewhere at runtime instead of a clear failure at boot.
  // DEFAULTS is the source of truth for which fields are numeric — several
  // other fields (apiToken, openaiApiKey, personalNumber) also default to
  // `null` without being numeric at all, so nullable-and-numeric needs its
  // own explicit list instead of inferring it from the default alone.
  const NUMERICOS_NULAVEIS = new Set(['timeoutMs'])
  for (const [campo, padrao] of Object.entries(DEFAULTS)) {
    const nulavel = NUMERICOS_NULAVEIS.has(campo)
    if (typeof padrao !== 'number' && !nulavel) continue
    if (nulavel && cfg[campo] == null) continue
    if (typeof cfg[campo] === 'number' && Number.isFinite(cfg[campo])) continue
    log?.warn?.(`[config] "${campo}" não é um número válido (${JSON.stringify(cfg[campo])}); usando o padrão ${JSON.stringify(padrao)}.`)
    cfg[campo] = padrao
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
