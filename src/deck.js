import { spawn } from 'node:child_process'

// Every call to agent-deck other than `send` is bookkeeping: if one of them
// hangs, it is a bug in the deck, not work worth waiting for.
const CLI_TIMEOUT_MS = 30000
const LAUNCH_TIMEOUT_MS = 90000
// `send --wait` refuses "no limit". The bot's own policy is to never kill a long
// job for passing a number (/stop is what interrupts), so ask for the largest
// wait the deck will honour instead.
const SEND_TIMEOUT = '720h'

const CONFIANCA = /Yes, I trust this folder/
const PRONTO = /shift\+tab to cycle|\? for shortcuts|bypass permissions/
const JANELA_CONFIANCA_MS = 15000

const CONFLITO = /stale concurrent|concurrent .*conflict/i
const TENTATIVAS = 4

export function execCli(bin, args, { stdin = null, timeoutMs = CLI_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let finalizado = false
    // Own process group, same reason as claude.js: `send --wait` spawns helpers,
    // and killing only the parent leaves them holding stdout open.
    const child = spawn(bin, args, { stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], detached: true })

    const matar = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const encerrar = (r) => {
      if (finalizado) return
      finalizado = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', aoAbortar)
      resolve(r)
    }
    const timer = timeoutMs ? setTimeout(() => { matar(); encerrar({ code: null, stdout: out, stderr: err, timedOut: true }) }, timeoutMs) : null
    const aoAbortar = () => { matar(); encerrar({ code: null, stdout: out, stderr: err, aborted: true }) }
    signal?.addEventListener('abort', aoAbortar, { once: true })

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => encerrar({ code: null, stdout: out, stderr: e.message }))
    child.on('close', (code) => encerrar({ code, stdout: out, stderr: err }))

    if (stdin != null) {
      child.stdin.on('error', () => {})
      child.stdin.end(stdin)
    }
  })
}

// `send --wait --json` prints a pretty-printed delivery receipt and then the
// reply as plain text on the same stream. Only the receipt is read here: the
// reply comes from `session output --json`, which carries a timestamp.
export function lerRecibo(stdout) {
  const texto = String(stdout ?? '')
  const inicio = texto.indexOf('{')
  if (inicio === -1) return null
  let profundidade = 0
  let emString = false
  let escapado = false
  for (let i = inicio; i < texto.length; i += 1) {
    const c = texto[i]
    if (emString) {
      if (escapado) escapado = false
      else if (c === '\\') escapado = true
      else if (c === '"') emString = false
      continue
    }
    if (c === '"') emString = true
    else if (c === '{') profundidade += 1
    else if (c === '}') {
      profundidade -= 1
      if (profundidade === 0) {
        try {
          return JSON.parse(texto.slice(inicio, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

function lerJson(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

function normalizar(s) {
  return {
    id: s.id,
    title: s.title,
    status: s.status,
    group: s.group ?? null,
    path: s.path,
    parentId: s.parent_session_id ?? null,
    lastActivityAt: s.last_activity_at ?? null,
    tmuxSession: s.tmux_session ?? null,
  }
}

export function createDeck({ bin = 'agent-deck', tmuxBin = 'tmux', runCli = execCli, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() } = {}) {
  const cli = (args, opts) => runCli(bin, args, opts)
  const tmux = (args) => runCli(tmuxBin, args, { timeoutMs: 5000 })

  // Replies already handed to WhatsApp by a conversation, keyed by title. The
  // notifier checks it so a reply you just read does not come back as an alert.
  const delivered = new Map()

  function falha(r, contexto) {
    const detalhe = (r.stderr || r.stdout || '').trim().slice(0, 300)
    if (r.timedOut) return new Error(`${contexto}: o agent-deck não respondeu a tempo`)
    return new Error(`${contexto}: ${detalhe || `exit ${r.code}`}`)
  }

  async function detect() {
    const r = await cli(['--version'], { timeoutMs: 5000 })
    return r.code === 0
  }

  async function list() {
    const r = await cli(['list', '--json'])
    if (r.code !== 0) throw falha(r, 'não consegui listar as sessões')
    const d = lerJson(r.stdout)
    const lista = Array.isArray(d) ? d : d?.sessions
    if (!Array.isArray(lista)) throw new Error('não entendi a lista de sessões do agent-deck')
    return lista.filter((s) => !s.archived).map(normalizar)
  }

  async function show(name) {
    const r = await cli(['session', 'show', name, '--json'])
    if (r.code !== 0) throw falha(r, `não achei a sessão ${name}`)
    return lerJson(r.stdout)
  }

  async function lastReply(name) {
    const r = await cli(['session', 'output', name, '--json'])
    if (r.code !== 0) return null
    const d = lerJson(r.stdout)
    if (!d || d.success === false) return null
    return { content: String(d.content ?? ''), timestamp: d.timestamp ?? null }
  }

  // Claude asks, once per folder, whether to trust it — with "No, exit" under
  // the cursor. A message sent into that dialog picks "No" and the session dies.
  // Headless `claude -p` never asks, so for sessions this daemon starts, answering
  // "Yes" keeps today's behaviour. Sessions it did not start are never touched.
  async function aceitarConfianca(name) {
    const limite = now() + JANELA_CONFIANCA_MS
    let pane = null
    while (now() < limite) {
      pane ??= (await show(name).catch(() => null))?.tmux_session ?? null
      if (pane) {
        const tela = (await tmux(['capture-pane', '-p', '-t', pane])).stdout
        if (CONFIANCA.test(tela)) {
          await tmux(['send-keys', '-t', pane, 'Down'])
          await tmux(['send-keys', '-t', pane, 'Enter'])
        } else if (PRONTO.test(tela)) {
          return
        }
      }
      await sleep(500)
    }
  }

  async function create({ cwd, name, group }) {
    const args = ['launch', cwd, '-t', name, '-c', 'claude', '-no-parent', '-json']
    if (group) args.push('-g', group)
    const r = await cli(args, { timeoutMs: LAUNCH_TIMEOUT_MS })
    const d = lerJson(r.stdout)
    if (r.code !== 0 || d?.success === false) throw falha(r, `não consegui criar ${name}`)
    await aceitarConfianca(name)
  }

  // agent-deck saves its state with optimistic concurrency. A start right after
  // a stop can lose that race to its own status writer ("stale concurrent
  // Status conflict"). That one error is transient, so it is retried; any other
  // failure is final. Before each retry the status is read again, so a first
  // attempt that did land is never repeated.
  async function comRetry(name, args, contexto, jaFeito) {
    for (let tentativa = 0; ; tentativa += 1) {
      const r = await cli(args, { timeoutMs: LAUNCH_TIMEOUT_MS })
      if (r.code === 0) return
      const transitorio = CONFLITO.test(`${r.stderr}${r.stdout}`)
      if (!transitorio || tentativa >= TENTATIVAS - 1) throw falha(r, contexto)
      await sleep(300 * 2 ** tentativa + Math.floor(Math.random() * 200))
      const estado = await show(name).catch(() => null)
      if (estado && jaFeito(estado.status)) return
    }
  }

  async function start(name) {
    await comRetry(name, ['session', 'start', name], `não consegui religar ${name}`,
      (status) => status !== 'stopped' && status !== 'error')
    await aceitarConfianca(name)
  }

  async function stop(name) {
    await comRetry(name, ['session', 'stop', name], `não consegui parar ${name}`, (status) => status === 'stopped')
  }

  // Killing our `send --wait` only stops us from waiting; the turn keeps running
  // in the pane. Escape is what Claude itself reads as "interrupt".
  async function interrupt(name) {
    const pane = (await show(name).catch(() => null))?.tmux_session
    if (pane) await tmux(['send-keys', '-t', pane, 'Escape'])
  }

  async function run({ name, prompt, signal, onSlow, slowNoticeMs = 8000, heartbeatMs = null } = {}) {
    // /end stops a session without deleting it. Talking to it again is the
    // obvious way to say "bring it back", so do that instead of failing.
    const estado = await show(name).catch(() => null)
    if (estado?.status === 'stopped' || estado?.status === 'error') {
      try {
        await start(name)
      } catch (err) {
        return { ok: false, text: '', sessionId: null, error: err.message }
      }
    }

    const comecou = now()
    let finalizado = false
    let batida = null
    const avisar = () => { if (!finalizado) onSlow?.(now() - comecou) }
    const timerLento = setTimeout(() => {
      avisar()
      if (heartbeatMs && !finalizado) batida = setInterval(avisar, heartbeatMs)
    }, slowNoticeMs)

    try {
      const r = await cli(
        ['session', 'send', name, '--message-file', '-', '--wait', '--json', '--defer-if-busy', '--timeout', SEND_TIMEOUT],
        { stdin: prompt, timeoutMs: null, signal },
      )

      if (r.aborted) {
        await interrupt(name).catch(() => {})
        return { ok: false, text: '', sessionId: null, error: 'Interrompido.' }
      }

      const recibo = lerRecibo(r.stdout)
      if (!recibo?.success) {
        const motivo = recibo?.error ?? ((r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`)
        return { ok: false, text: '', sessionId: null, error: `não entreguei para ${name}: ${motivo}` }
      }

      const resposta = await lastReply(name)
      if (!resposta) return { ok: false, text: '', sessionId: null, error: `${name} respondeu, mas não consegui ler a resposta` }
      // Older than the request means the turn ended without writing anything
      // new. Handing back the previous answer would read as a reply it is not.
      if (resposta.timestamp && Date.parse(resposta.timestamp) < comecou) {
        return { ok: false, text: '', sessionId: null, error: `${name} recebeu, mas terminou sem responder em texto` }
      }

      delivered.set(name, resposta.timestamp)
      return { ok: true, text: resposta.content, sessionId: null, error: null }
    } finally {
      finalizado = true
      clearTimeout(timerLento)
      clearInterval(batida)
    }
  }

  return { detect, list, show, lastReply, create, start, stop, interrupt, run, delivered }
}
