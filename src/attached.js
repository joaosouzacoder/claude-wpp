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

import { execFile } from 'node:child_process'
import { readLastReply } from './transcript.js'

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
    abrir: (nome, comando) => rodar(['new-session', '-d', '-s', nome, '-x', '200', '-y', '50', comando]),
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

// One turn inside his session. `agentId` is the short id `claude agents`
// lists; `sessionId` is the conversation the transcript is filed under.
export function createAttachedRunner({
  tmux = createTmux(),
  readReply = readLastReply,
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
    const falha = (error, podeCair = false) => ({ ok: false, text: '', sessionId, error, podeCair })
    if (!agentId || !sessionId) return falha('faltou o id da sessão dele', true)
    // `tmux new-session` runs its command through a shell, and this id comes
    // from a listing, not from a constant: anything but an id stops here.
    if (!/^[A-Za-z0-9-]{4,64}$/.test(agentId)) return falha(`id de sessão estranho: "${agentId}"`, true)
    if (!await tmux.disponivel()) return falha('tmux não está instalado aqui', true)

    const janela = nomeJanela(nome)
    if (!await tmux.viva(janela)) {
      const aberta = await tmux.abrir(janela, `${bin} attach ${agentId}`)
      if (!aberta.ok) return falha(`não consegui abrir a sessão dele: ${aberta.stderr.trim().slice(0, 160)}`, true)
      await sleep(ESPERA_ATTACH_MS)
    }

    // Anything already in the transcript is not this turn's answer.
    const anterior = await readReply({ cwd, sessionId })
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

      const resposta = await readReply({ cwd, sessionId }).catch(() => null)
      const nova = resposta?.content && resposta.timestamp !== marcoAnterior

      if (nova && candidata?.timestamp === resposta.timestamp && now() - candidata.vistaEm >= SOSSEGO_MS) {
        return { ok: true, text: resposta.content, sessionId, error: null }
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
