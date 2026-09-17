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
  // Throws when the listing itself could not be trusted (subprocess failed,
  // timed out, or printed something that isn't the JSON array it always
  // prints on success) — distinct from a successful call that simply does
  // not contain the id being looked for. Callers that only care about
  // best-effort listing (the busy precheck, the orphan sweep, /manuais) can
  // still `.catch(() => null)` this; the poll loop below is the one place
  // that needs to tell the two apart.
  async function listAgents(bin) {
    const r = await runCli(bin, ['agents', '--json', '--all'], { timeoutMs: DISPATCH_TIMEOUT_MS })
    if (r.code !== 0) {
      throw new Error(r.timedOut ? 'claude agents não respondeu a tempo' : (r.stderr || r.stdout || '').trim().slice(0, 200) || `exit ${r.code}`)
    }
    const d = lerJson(r.stdout)
    if (!Array.isArray(d)) throw new Error('não entendi a saída de claude agents --json')
    return d
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
    appendSystemPrompt = null,
    onSlow,
    onNotice,
    signal,
  } = {}) {
    // A brand-new folder asks, once, whether to trust it — a dialog `--bg`
    // sits on forever instead of skipping like `-p` does. Only relevant the
    // first time this cwd gets a session; --resume means it already went
    // through this.
    if (!sessionId) trust(cwd)

    // `--resume` on a session that is genuinely busy elsewhere (someone
    // attached to it, or /importar picked one mid-turn) does start a copy
    // like the CLI promises, but if that turn had a background shell command
    // still pending, the copy has been observed getting stuck replaying it
    // forever, landing in `state: blocked` with no way out but /stop. Refusing
    // up front is cheaper than debugging a wedged copy after the fact.
    if (sessionId) {
      const lista = await listAgents(bin).catch(() => null)
      const emUso = lista?.find((s) => s.sessionId === sessionId && s.status === 'busy')
      if (emUso) {
        return {
          ok: false,
          text: '',
          sessionId,
          error: `essa sessão está ocupada agora rodando de verdade em outro lugar (${emUso.id ?? 'sem id'}) — tenta de novo quando ela terminar, ou acompanhe com \`claude attach ${emUso.id ?? ''}\`.`,
        }
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

    let bgId = null
    let sessionIdCompleto = sessionId
    let avisouBloqueio = false
    const pararSessao = () => (bgId ? runCli(bin, ['stop', bgId], { timeoutMs: STOP_TIMEOUT_MS }).catch(() => {}) : null)
    const pararERemover = async (id) => {
      await runCli(bin, ['stop', id], { timeoutMs: STOP_TIMEOUT_MS }).catch(() => {})
      await runCli(bin, ['rm', id], { timeoutMs: STOP_TIMEOUT_MS }).catch(() => {})
    }
    // The background agent has no reason to stay resident once its turn is
    // over: the next message dispatches a fresh `--bg --resume`, which
    // reconstructs everything from the transcript regardless of whether this
    // one is still around. Leaving it running only holds a process open
    // forever and clutters `claude agents` with sessions that already
    // answered — which is what `/end` used to leave behind on an idle
    // session, since there was nothing in flight left to abort.
    //
    // A session picked up with /importar (or one that predates this cleanup)
    // can already have its own finished-but-not-removed entry sitting under
    // the same name from before this bot ever dispatched anything. Resuming
    // a session that has genuinely exited (not just gone idle) does not
    // reuse its id: claude forks the conversation into a brand-new sessionId
    // and copies the history forward, so sessionIdCompleto can end up
    // different from the sessionId this run was asked to resume — leaving
    // the one it forked *from* permanently orphaned if only the current id
    // is ever swept. Sweep stale entries under either.
    const limparSessao = async () => {
      if (bgId) await pararERemover(bgId)
      const alvos = new Set([sessionIdCompleto, sessionId].filter(Boolean))
      if (!alvos.size) return
      const lista = await listAgents(bin).catch(() => null)
      const orfas = lista?.filter((s) => alvos.has(s.sessionId) && s.id && s.id !== bgId && s.status !== 'busy') ?? []
      for (const orfa of orfas) await pararERemover(orfa.id)
    }

    const aoAbortar = () => { pararSessao() }
    signal?.addEventListener('abort', aoAbortar, { once: true })

    try {
      const args = ['--bg', '--dangerously-skip-permissions']
      if (name) args.push('-n', name)
      if (sessionId) args.push('--resume', sessionId)
      if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt)
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

      let quietas = 0
      for (;;) {
        if (signal?.aborted) return { ok: false, text: '', sessionId: sessionIdCompleto, error: 'Interrompido.' }
        if (timeoutMs && now() - comecou > timeoutMs) {
          await pararSessao()
          return { ok: false, text: '', sessionId: sessionIdCompleto, error: `Passei do tempo limite (${Math.round(timeoutMs / 1000)}s) e cancelei.` }
        }

        let lista
        let falhaDaListagem = false
        try {
          lista = await listAgents(bin)
        } catch {
          // The status check itself failed (subprocess hiccup, timeout, bad
          // output) — inconclusive, not "the agent is gone". Treating this
          // the same as "vanished" would tear down a turn that is still
          // genuinely running over one transient blip.
          falhaDaListagem = true
          lista = null
        }
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
        } else if (falhaDaListagem) {
          // Same quiet-tolerance a merely-idle agent gets, not zero — a
          // failed status check earns the benefit of the doubt too.
          quietas += 1
          if (quietas >= OLHADAS_QUIETAS) break
        } else {
          quietas += 1
          if (!estado || quietas >= OLHADAS_QUIETAS) break
        }
        await sleep(POLL_INTERVAL_MS)
      }

      const resposta = await readReply({ cwd, sessionId: sessionIdCompleto })
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
      await limparSessao()
    }
  }

  return { run, listAgents }
}

const claudePadrao = createClaude()

export function runClaude(opts) {
  return claudePadrao.run(opts)
}

// Every claude session on this host, not just the ones this bot started —
// what `/manuais` shows so a session started by hand can be picked up here.
export function listAgents(bin = 'claude') {
  return claudePadrao.listAgents(bin)
}
