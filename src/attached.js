// Answering inside a session he opened himself, instead of beside it.
//
// `claude --bg --resume` always forks the conversation into a new id: the CLI
// has no verb that hands a turn to a live agent. What it does have is
// `claude attach`, which opens one in a terminal — so the bot keeps that
// terminal in tmux and types into it. The turn then happens in his session,
// under his session's id, and nothing new shows up in `claude agents`.
//
// The reply is not scraped from the terminal. Claude Code writes every turn
// to the conversation's transcript, which is the same file the rest of this
// project already reads, so the answer is read from there — no parsing of a
// TUI that is free to change.
//
// A session he started in his own terminal is not in `claude agents` and has
// no id to attach to. There the window opens the conversation itself, with
// `--resume`, which forks it once into a new id — after that the window is
// where the conversation lives, so nothing forks again and he can join it
// with `tmux attach`. The new id is found by looking for the transcript that
// appeared after the window opened.

import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { readLastReply, transcriptPath } from './transcript.js'

const ESPERA_ATTACH_MS = 12000
const INTERVALO_POLL_MS = 2000
// A turn is done when a new assistant message has been on disk for this long
// without another one following it: Claude Code writes several as it works.
const SOSSEGO_MS = 6000

export function createTmux({ exec = execFile, bin = 'tmux', timeoutMs = 15000 } = {}) {
  const rodar = (args) => new Promise((resolve) => {
    exec(bin, args, { timeout: timeoutMs }, (erro, stdout, stderr) => {
      resolve({ ok: !erro, stdout: String(stdout ?? ''), stderr: String(stderr ?? erro?.message ?? '') })
    })
  })

  return {
    disponivel: async () => (await rodar(['-V'])).ok,
    viva: async (nome) => (await rodar(['has-session', '-t', nome])).ok,
    abrir: (nome, comando, cwd = null) => rodar([
      'new-session', '-d', '-s', nome, '-x', '200', '-y', '50',
      ...(cwd ? ['-c', cwd] : []), comando,
    ]),
    matar: (nome) => rodar(['kill-session', '-t', nome]),
    // Bracketed paste, so a line break inside the text is text and not the
    // Enter that submits it half-written.
    async digitar(nome, texto) {
      const buffer = `wpp-${nome}`
      const r = await new Promise((resolve) => {
        const filho = exec(bin, ['load-buffer', '-b', buffer, '-'], { timeout: timeoutMs }, (erro) => resolve({ ok: !erro }))
        filho.stdin.end(texto)
      })
      if (!r.ok) return r
      const colado = await rodar(['paste-buffer', '-p', '-d', '-b', buffer, '-t', nome])
      if (!colado.ok) return colado
      return rodar(['send-keys', '-t', nome, 'Enter'])
    },
  }
}

const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms))

// The transcript that showed up after the window opened. `--resume` forks the
// conversation into an id nobody announces, and this is how the fork is found:
// the newest transcript in the same project folder that is not the one we
// resumed from.
export async function descobrirSessao({ cwd, anterior, desde, home, listar = readdir, medir = stat } = {}) {
  const pasta = dirname(transcriptPath(cwd, 'x', home ? { home } : {}))
  let arquivos
  try {
    arquivos = await listar(pasta)
  } catch {
    return null
  }

  let melhor = null
  for (const arquivo of arquivos) {
    if (!arquivo.endsWith('.jsonl')) continue
    const id = arquivo.slice(0, -'.jsonl'.length)
    if (id === anterior) continue
    let quando
    try {
      quando = (await medir(`${pasta}/${arquivo}`)).mtimeMs
    } catch {
      continue
    }
    if (desde && quando < desde) continue
    if (!melhor || quando > melhor.quando) melhor = { id, quando }
  }
  return melhor?.id ?? null
}

// One turn inside his session. `agentId` is the short id `claude agents`
// lists; `sessionId` is the conversation the transcript is filed under.
export function createAttachedRunner({
  tmux = createTmux(),
  readReply = readLastReply,
  descobrir = descobrirSessao,
  bin = 'claude',
  now = () => Date.now(),
  sleep = dormir,
  log = null,
} = {}) {
  const nomeJanela = (sessao) => `wpp-${sessao}`

  return async function runAttached({
    nome, cwd, agentId, sessionId, prompt,
    slowNoticeMs = 8000, heartbeatMs = null, timeoutMs = null,
    onSlow, onNotice, signal,
  }) {
    // `podeCair` marks the failures where the message never reached his
    // session at all — there the caller may still try the ordinary path. A
    // timeout is not one of them: the text was typed, and sending it again by
    // another route would ask him the same thing twice.
    let alvo = sessionId
    const janela = nomeJanela(nome)
    const falha = (error, podeCair = false) => ({ ok: false, text: '', sessionId: alvo, janela, abriu: false, error, podeCair })
    if (!sessionId) return falha('faltou o id da conversa dele', true)
    // Both ids end up inside a command `tmux new-session` runs through a
    // shell, and they come from a listing, not from a constant: anything that
    // is not an id stops here.
    const idValido = (v) => /^[A-Za-z0-9-]{4,64}$/.test(v)
    if (agentId && !idValido(agentId)) return falha(`id de sessão estranho: "${agentId}"`, true)
    if (!idValido(sessionId)) return falha(`id de conversa estranho: "${sessionId}"`, true)
    if (!await tmux.disponivel()) return falha('tmux não está instalado aqui', true)

    let abriu = false
    if (!await tmux.viva(janela)) {
      // With an agent id the window attaches to the live agent and the
      // conversation keeps its id. Without one — a session he started in his
      // own terminal — the window opens the conversation itself, which forks
      // it once. Permission prompts are skipped because nobody is at this
      // terminal to answer them; the window is the bot's, and he joins it.
      const comando = agentId
        ? `${bin} attach ${agentId}`
        : `${bin} --resume ${sessionId} --dangerously-skip-permissions`
      const desde = now()
      const aberta = await tmux.abrir(janela, comando, cwd)
      if (!aberta.ok) return falha(`não consegui abrir a sessão dele: ${aberta.stderr.trim().slice(0, 160)}`, true)
      abriu = true
      await sleep(ESPERA_ATTACH_MS)

      // `--resume` on a conversation whose process is gone continues in the
      // same transcript, and that is the good case: the turn lands in his
      // file. It only forks when the session is still hosted, and then a new
      // transcript shows up right after the window opened — that one is where
      // the conversation went, so the reply is read from there instead.
      if (!agentId) {
        const nova = await descobrir({ cwd, anterior: sessionId, desde }).catch(() => null)
        if (nova) alvo = nova
      }
    }

    // Anything already in the transcript is not this turn's answer.
    const anterior = await readReply({ cwd, sessionId: alvo })
    const marcoAnterior = anterior?.timestamp ?? null

    const digitado = await tmux.digitar(janela, prompt)
    if (!digitado.ok) {
      await tmux.matar(janela)
      return falha(`não consegui digitar na sessão dele: ${digitado.stderr.trim().slice(0, 160)}`, true)
    }

    const comecou = now()
    let avisouLento = false
    let ultimaBatida = comecou
    let candidata = null

    while (true) {
      if (signal?.aborted) return falha('Interrompido.')
      if (timeoutMs && now() - comecou > timeoutMs) return falha(`passei do tempo limite (${Math.round(timeoutMs / 1000)}s) esperando a sessão ${nome}`)

      const resposta = await readReply({ cwd, sessionId: alvo }).catch(() => null)
      const nova = resposta?.content && resposta.timestamp !== marcoAnterior

      if (nova && candidata?.timestamp === resposta.timestamp && now() - candidata.vistaEm >= SOSSEGO_MS) {
        return { ok: true, text: resposta.content, sessionId: alvo, janela, abriu, error: null }
      }
      if (nova && candidata?.timestamp !== resposta.timestamp) candidata = { timestamp: resposta.timestamp, vistaEm: now() }

      const decorrido = now() - comecou
      if (!avisouLento && slowNoticeMs && decorrido >= slowNoticeMs) {
        avisouLento = true
        onSlow?.()
      }
      if (heartbeatMs && avisouLento && now() - ultimaBatida >= heartbeatMs) {
        ultimaBatida = now()
        onNotice?.(`Ainda trabalhando nisso (${Math.round(decorrido / 60000)}min).`)
      }
      log?.debug?.(`[attached ${nome}] esperando resposta (${Math.round(decorrido / 1000)}s)`)
      await sleep(INTERVALO_POLL_MS)
    }
  }
}
