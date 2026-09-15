import { spawn } from 'node:child_process'
import { ensureTrusted } from './trust.js'
import { readLastReply } from './transcript.js'

// `claude --bg` itself only has to print the id and return; the actual work
// happens in the background session it just started.
const DISPATCH_TIMEOUT_MS = 30000
const STOP_TIMEOUT_MS = 10000
const POLL_INTERVAL_MS = 2000
// A turn resumed after a blocked moment (or the instant right after dispatch)
// can show up as non-busy for one look before it flips back to busy. One
// quiet look is not "it is over" — same reasoning `agent-deck` used to need
// around its own tmux polling.
const OLHADAS_QUIETAS = 3

export function execCli(bin, args, { cwd, timeoutMs = DISPATCH_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let finalizado = false
    // Own process group: killing only the parent would leave `claude`'s own
    // children (this dispatch call is brief, but not guaranteed instant)
    // holding stdout open.
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: true })

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
  })
}

// "backgrounded · <id> · <name>", with the id in an ANSI color and the name
// omitted when none was given.
export function parseBgId(stdout) {
  const limpo = String(stdout ?? '').replace(/\x1b\[[0-9;]*m/g, '')
  const m = limpo.match(/backgrounded\s*·\s*([a-f0-9]{6,})/)
  return m ? m[1] : null
}

function lerJson(stdout) {
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

export function createClaude({
  bin: defaultBin = 'claude',
  runCli = execCli,
  trust = ensureTrusted,
  readReply = readLastReply,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
} = {}) {
  async function listAgents(bin) {
    const r = await runCli(bin, ['agents', '--json', '--all'], { timeoutMs: DISPATCH_TIMEOUT_MS })
    if (r.code !== 0) return null
    const d = lerJson(r.stdout)
    return Array.isArray(d) ? d : null
  }

  async function run({
    bin = defaultBin,
    name = null,
    cwd,
    prompt,
    sessionId = null,
    slowNoticeMs = 8000,
    heartbeatMs = null,
    timeoutMs = null,
    onSlow,
    onNotice,
    signal,
  } = {}) {
    // A brand-new folder asks, once, whether to trust it — a dialog `--bg`
    // sits on forever instead of skipping like `-p` does. Only relevant the
    // first time this cwd gets a session; --resume means it already went
    // through this.
    if (!sessionId) trust(cwd)

    const comecou = now()
    let finalizado = false
    let batida = null
    const avisar = () => { if (!finalizado) onSlow?.(now() - comecou) }
    const timerLento = setTimeout(() => {
      avisar()
      if (heartbeatMs && !finalizado) batida = setInterval(avisar, heartbeatMs)
    }, slowNoticeMs)

    let bgId = null
    let avisouBloqueio = false
    const pararSessao = () => (bgId ? runCli(bin, ['stop', bgId], { timeoutMs: STOP_TIMEOUT_MS }).catch(() => {}) : null)

    const aoAbortar = () => { pararSessao() }
    signal?.addEventListener('abort', aoAbortar, { once: true })

    try {
      const args = ['--bg', '--dangerously-skip-permissions']
      if (name) args.push('-n', name)
      if (sessionId) args.push('--resume', sessionId)
      args.push(prompt)

      const enviadoEm = now()
      const disparo = await runCli(bin, args, { cwd, timeoutMs: DISPATCH_TIMEOUT_MS })
      if (disparo.timedOut) return { ok: false, text: '', sessionId, error: 'o claude não confirmou o disparo em segundo plano a tempo' }
      if (disparo.code !== 0) {
        const detalhe = (disparo.stderr || disparo.stdout || '').trim().slice(0, 300)
        return { ok: false, text: '', sessionId, error: detalhe || `exit ${disparo.code}` }
      }
      bgId = parseBgId(disparo.stdout)
      if (!bgId) return { ok: false, text: '', sessionId, error: `não entendi a confirmação de disparo do claude: ${disparo.stdout.trim().slice(0, 200)}` }

      // An abort that arrived while the dispatch call was in flight found no
      // bgId yet, so the listener below had nothing to stop. Catch that up
      // now that the background agent's id is known.
      if (signal?.aborted) { await pararSessao(); return { ok: false, text: '', sessionId, error: 'Interrompido.' } }

      let sessionIdCompleto = sessionId
      let quietas = 0
      for (;;) {
        if (signal?.aborted) return { ok: false, text: '', sessionId: sessionIdCompleto, error: 'Interrompido.' }
        if (timeoutMs && now() - comecou > timeoutMs) {
          await pararSessao()
          return { ok: false, text: '', sessionId: sessionIdCompleto, error: `Passei do tempo limite (${Math.round(timeoutMs / 1000)}s) e cancelei.` }
        }

        const lista = await listAgents(bin)
        const estado = lista?.find((s) => s.id === bgId) ?? null
        if (estado?.sessionId) sessionIdCompleto = estado.sessionId

        if (estado?.status === 'busy') {
          quietas = 0
        } else if (estado?.state === 'blocked') {
          // Stuck waiting on something only a human can answer (a dialog our
          // own flags did not cover). Say so once and keep waiting — same
          // no-ceiling policy as a legitimately long turn; /stop interrupts.
          if (!avisouBloqueio) {
            avisouBloqueio = true
            onNotice?.(`parou esperando algo no claude — rode \`claude attach ${bgId}\` no host pra ver o quê. Sua mensagem já chegou.`)
          }
          quietas = 0
        } else {
          quietas += 1
          if (!estado || quietas >= OLHADAS_QUIETAS) break
        }
        await sleep(POLL_INTERVAL_MS)
      }

      const resposta = readReply({ cwd, sessionId: sessionIdCompleto })
      if (!resposta) return { ok: false, text: '', sessionId: sessionIdCompleto, error: `${name ?? bgId} respondeu, mas não consegui ler a resposta` }
      if (resposta.timestamp && Date.parse(resposta.timestamp) < enviadoEm) {
        return { ok: false, text: '', sessionId: sessionIdCompleto, error: `${name ?? bgId} recebeu, mas terminou sem responder em texto` }
      }
      return { ok: true, text: resposta.content, sessionId: sessionIdCompleto, error: null }
    } finally {
      finalizado = true
      clearTimeout(timerLento)
      clearInterval(batida)
      signal?.removeEventListener('abort', aoAbortar)
    }
  }

  return { run, listAgents }
}

const claudePadrao = createClaude()

export function runClaude(opts) {
  return claudePadrao.run(opts)
}
