import { rmSync, statSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse } from './router.js'
import { emAndamento } from './claude.js'
import { chunkText } from './text.js'
import { promptComImagem, promptComArquivo, extrairArquivos } from './media.js'
import { mimetypeDe } from './mimetypes.js'
import { formatDraft, formatQueue } from './wpp.js'
import { createIntent, textoCitado } from './intent.js'

const SESSAO_WPP = 'wpp'

// The butler speaks as himself: his replies carry no session label, because
// to the owner this is not "a session answered", it is the assistant talking.
// A project session keeps its name, since several of them answer out of order.
const etiqueta = (nome) => (nome === SESSAO_WPP ? '' : `[${nome}] `)

// Enough of a long reply's opening to tell what it says without opening the
// attachment, and well under what WhatsApp shows of a caption.
const PREVIA_ANEXO = 700

// Every reply dispatched from here is read on a phone screen inside
// WhatsApp, not a terminal. Recorded once per conversation (Claude Code's
// system-prompt snapshot), so it only takes effect from a session's first
// message onward — a session /importar picked up already had its own
// snapshot locked in before this bot ever touched it.
const FORMATO_WHATSAPP = 'Your reply will be read on WhatsApp, not a terminal or an IDE. Format it for that: short paragraphs, plain text, no large tables or deeply nested markdown — write so it reads well on a phone screen. To hand the user a file (a report, CSV, chart, PDF, image you created or found), write `[[arquivo: /absolute/path]]` on a line of its own — it is sent to them as an attachment and the line is removed from your reply. Only for files that exist; one line per file.'

// Past this, a file named in a reply is not read into memory to be sent.
const LIMITE_ARQUIVO_SAIDA = 64 * 1024 * 1024

const AJUDA = [
  'Fala comigo normal — eu entendo e faço. Os comandos abaixo são atalho, não obrigação.',
  '',
  'Comandos:',
  '/new [dir] [nome] — cria sessão e ativa',
  '/ls — lista as sessões',
  '/manuais — lista sessões do claude neste host que o bot não controla',
  '/importar <n> [nome] — adota a sessão n da lista de /manuais',
  '/use <nome> — troca a sessão ativa',
  '/cd <dir> — muda a pasta da sessão ativa (a conversa recomeça)',
  '/end [nome] — encerra (sem nome, encerra a ativa)',
  '/stop — interrompe o que a sessão ativa está fazendo',
  '/retomar [nome] — refaz o pedido que morreu num reinício',
  '/descartar [nome] — esquece o pedido que morreu num reinício',
  '/help — isto aqui',
  '@nome texto — manda pra outra sessão sem trocar a ativa',
  '',
  'Sua conta pessoal:',
  '/wpp <pedido> — o mesmo que falar comigo direto (é para onde vai tudo sem barra)',
  '/ok <n> — aprova o rascunho n e manda como você (só assim ele sai)',
  '/bot <n> — aprova o rascunho n e manda pelo número do bot',
  '/edit <n> <texto> — reescreve o rascunho n (volta a precisar de /ok)',
  '/no <n> — descarta o rascunho ou cancela o agendamento n',
  '/schedulers — o que espera seu ok e o que está agendado',
  '/undo — apaga a última mensagem que mandei por você',
  '',
  'Respostas ao bot:',
  'citar uma resposta encaminhada — formalizo sua resposta e mando pelo bot',
  '/r <n> <texto> — o mesmo, pelo número da resposta',
  '',
  'Áudio vira texto e segue como se você tivesse digitado (comandos inclusive).',
  'Pode falar normal: "manda o 3 pelo bot", "descarta esse", "avisa a Ana que…" viram o comando.',
  'Imagem vai junto do pedido; a legenda é o prompt.',
].join('\n')

// Accepts "3", "#3" and "d3" — you are typing this on a phone.
function numeroDoRascunho(bruto) {
  const digitos = String(bruto ?? '').replace(/[^0-9]/g, '')
  return digitos ? Number(digitos) : null
}

// A claude-agents name is freeform (spaces, punctuation, whatever `-n` got);
// a session name here is not. Squash it into something sessions.create()
// accepts, or give up and let it fall back to the usual s1/s2.
function nomeSugerido(bruto) {
  const limpo = String(bruto ?? '').trim().replace(/[^a-z0-9_-]/gi, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  return limpo || null
}

function duracao(ms) {
  const min = Math.round(ms / 60000)
  if (min < 1) return 'menos de 1min'
  if (min < 60) return `${min}min`
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

function ociosidade(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min}min`
  return `${Math.floor(min / 60)}h`
}

export function createHandler({ sessions, run, runAttached = null, attach = null, transcribe, reply, replyFile = null, config, wpp = null, listAgents = null, relay = null, classify = null, log = null }) {
  // What /manuais last showed, so /importar <n> knows which session that
  // number meant. Only ever read right after a fresh /manuais.
  let sessoesManuais = []

  // A session keeps the instructions it read when it started. Editing
  // agent/CLAUDE.md would otherwise only take effect whenever someone
  // remembered to /end the wpp session — so a fix to how the agent writes
  // could sit unused for days while it kept doing the old thing.
  function instrucoesMudaram(sessao) {
    try {
      return statSync(join(wpp.agentCwd, 'CLAUDE.md')).mtimeMs > new Date(sessao.createdAt).getTime()
    } catch {
      return false
    }
  }

  // The agent cannot know what the bot itself has already said to someone —
  // that lives outside the log it reads. Without this it greets and
  // introduces itself to a person the bot spoke to an hour ago.
  function comContexto(pedido) {
    const contatos = wpp.botContatos?.() ?? []
    if (!contatos.length) return pedido
    const lista = contatos.map((c) => `${c.name ?? c.number} (${c.number}), última vez ${ociosidade(new Date(c.last_sent_at * 1000).toISOString())} atrás`).join('\n')
    return [
      pedido,
      '',
      `[pelo número do bot, você (${wpp.assistente ?? 'o assistente'}) já conversou com estas pessoas:`,
      lista,
      'antes de escrever --body-bot para alguém desta lista, leia a conversa em bot_messages e continue de onde parou, sem cumprimentar nem se apresentar de novo]',
    ].join('\n')
  }

  // Files Claude marked for delivery go out after its text, each as an
  // attachment. Always to the owner: `reply`/`replyFile` only ever reach
  // authorizedNumber, whatever path the reply names.
  async function responder(nome, texto, cwd = config.defaultCwd) {
    const { texto: limpo, arquivos } = extrairArquivos(texto, cwd)
    if (limpo || !arquivos.length) await responderTexto(nome, limpo)
    for (const caminho of arquivos) await entregarArquivo(nome, caminho)
  }

  async function entregarArquivo(nome, caminho) {
    const nomeArquivo = basename(caminho)
    let info
    try {
      info = statSync(caminho)
    } catch {
      return reply(`${etiqueta(nome)}(não achei o arquivo ${caminho} para anexar)`)
    }
    if (!info.isFile()) return reply(`${etiqueta(nome)}(${caminho} não é um arquivo — não anexei)`)
    if (info.size > LIMITE_ARQUIVO_SAIDA) {
      return reply(`${etiqueta(nome)}(${nomeArquivo} tem ${Math.round(info.size / 1024 / 1024)} MB — grande demais para anexar; está em ${caminho})`)
    }
    if (!replyFile) return reply(`${etiqueta(nome)}(arquivo em ${caminho})`)
    try {
      await replyFile({ content: readFileSync(caminho), fileName: nomeArquivo, caption: `${etiqueta(nome)}${nomeArquivo}`, mimetype: mimetypeDe(nomeArquivo) })
    } catch (err) {
      await reply(`${etiqueta(nome)}(não consegui anexar ${nomeArquivo}: ${err.message}; está em ${caminho})`)
    }
  }

  async function responderTexto(nome, texto) {
    // A long reply as a run of bubbles cannot be read or searched on a phone.
    // As a file it can — with the opening in the caption, so the gist still
    // shows up in the chat. If the attachment cannot go out, the bubbles still
    // do: a reply must never be lost to its own formatting.
    if (replyFile && texto.length > config.attachAboveChars) {
      const [previa] = chunkText(texto, PREVIA_ANEXO)
      try {
        await replyFile({
          content: texto,
          fileName: `${nome}.txt`,
          caption: `${etiqueta(nome)}${previa}\n\n… resposta completa (${texto.length} caracteres) no anexo.`,
        })
        return
      } catch {}
    }
    for (const pedaco of chunkText(texto, config.maxMessageChars)) {
      await reply(`${etiqueta(nome)}${pedaco}`)
    }
  }

  async function executar(sessao, prompt) {
    // On disk before the first token: if this process dies mid-run, the next
    // boot is the only thing left that can tell you the reply is owed.
    sessions.beginRun(sessao.name, prompt)

    // A session he opened himself is answered *inside* it: `--bg --resume`
    // would fork the conversation into a new id and leave his own sitting
    // idle, which is exactly what he did not want. `runAttached` types into
    // it through `claude attach`, so his session is the one that answers.
    // Anything that stops that — no tmux, a dead window — falls back to the
    // old path rather than dropping the message.
    if (runAttached && sessao.adotadaDe && sessao.agenteId) {
      const r = await conduzir(sessao, (opcoes) => runAttached({
        ...opcoes,
        prompt,
        agentId: sessao.agenteId,
        sessionId: sessao.claudeSessionId,
        nome: sessao.name,
      }), { permitirQueda: true })
      if (!r?.caiu) return r
      log?.warn?.(`[${sessao.name}] não consegui responder dentro da sessão dele (${r.motivo}); vou pela via normal.`)
      sessions.beginRun(sessao.name, prompt)
    }

    return conduzir(sessao, (opcoes) => run({
      ...opcoes,
      prompt,
      sessionId: sessao.claudeSessionId,
      appendSystemPrompt: FORMATO_WHATSAPP,
      // The conversation he opened himself, when this name was taken over
      // from one: the sweep may tidy up our own forks, never his session.
      preservar: sessao.adotadaDe ? [sessao.adotadaDe] : [],
      // On a conversation of his, the bot's side of it stays listed under a
      // name of its own — `infra-wpp` next to his `infra` — so it is clear
      // where the answers are happening, and he can `claude attach` it.
      ...(sessao.adotadaDe ? { name: `${sessao.name}-wpp`, manterEntrada: true } : {}),
    }))
  }

  // Carries one turn from start to delivered reply, whether it was dispatched
  // just now or picked back up after a restart: the busy flag, the progress
  // notices, the answer, and draining whatever queued up behind it.
  async function conduzir(sessao, iniciar, { avisou = false, permitirQueda = false } = {}) {
    sessao.busy = true
    sessao.abort = new AbortController()

    try {
      // run() rejecting outright (not resolving {ok:false, error}, which is
      // its normal way of reporting a failure) must still land on the same
      // path: otherwise the exception skips straight past the queue-drain
      // continuation below, orphaning whatever is already queued behind it.
      const r = await iniciar({
        bin: config.claudeBin,
        name: sessao.name,
        cwd: sessao.cwd,
        slowNoticeMs: config.slowNoticeMs,
        heartbeatMs: config.heartbeatMs,
        timeoutMs: config.timeoutMs,
        blockedTimeoutMs: config.blockedTimeoutMs,
        signal: sessao.abort.signal,
        onSlow: (decorrido) => {
          const texto = avisou
            ? `Ainda trabalhando nisso (${duracao(decorrido)}).`
            : 'Trabalhando nisso.'
          avisou = true
          reply(texto).catch(() => {})
        },
        onNotice: (texto) => { reply(`${etiqueta(sessao.name)}${texto}`).catch(() => {}) },
        onDispatch: (disparo) => sessions.markDispatched(sessao.name, disparo),
      }).catch((err) => ({ ok: false, text: '', sessionId: null, error: err.message ?? String(err) }))

      // sessionBroken means the id we tried to --resume is proven dead (claude
      // reported it as a failed session, not just busy or blocked elsewhere) —
      // keeping it would only make every future message repeat this same
      // failure forever. Drop it so the next one starts a fresh conversation
      // instead of resuming a target that can never come back.
      // Could not even get the message in front of him: say so upstream and
      // let the caller try the other path, instead of reporting an error he
      // can do nothing about.
      if (permitirQueda && !r.ok && r.podeCair) return { caiu: true, motivo: r.error }

      if (r.sessionBroken) sessao.claudeSessionId = null
      else if (r.sessionId) sessao.claudeSessionId = r.sessionId
      sessions.touch(sessao.name)

      // A delivery failure here (WhatsApp send rejecting) must never strand
      // whatever is already queued behind this turn — the run itself did
      // finish, so the queue still has to drain, the same way onSlow/onNotice
      // above already tolerate reply() failing.
      await responder(sessao.name, r.ok ? r.text : `Erro: ${r.error}`, sessao.cwd).catch(() => {})
    } finally {
      sessao.busy = false
      sessao.abort = null
      sessions.endRun(sessao.name)
    }

    const proxima = sessions.dequeue(sessao.name)
    if (proxima != null) await executar(sessao, proxima)
  }

  async function despachar(sessao, prompt) {
    if (sessao.busy) {
      sessions.enqueue(sessao.name, prompt)
      return
    }
    if (sessao.pending) {
      // A crash-interrupted request is still waiting on /retomar or
      // /descartar. beginRun() unconditionally overwrites `pending`, so
      // starting a fresh turn now would silently erase that bookkeeping —
      // queue this one instead of racing or clobbering it.
      sessions.enqueue(sessao.name, prompt)
      await reply(`[${sessao.name}] tem um pedido interrompido esperando você: manda /retomar ${sessao.name} ou /descartar ${sessao.name} primeiro. Guardei essa mensagem pra depois.`).catch(() => {})
      return
    }
    await executar(sessao, prompt)
  }

  // Only a turn in progress (starting up included) or `blocked` means it is
  // still going. Anything else — gone from the listing, done, failed, or a
  // listing that could not be read — falls through to asking you, which is
  // the safe side: nothing re-runs on its own.
  async function agenteVivo(bgId) {
    if (!bgId || !attach || !listAgents) return false
    const lista = await listAgents(config.claudeBin).catch(() => null)
    const estado = lista?.find((a) => a.id === bgId)
    return emAndamento(estado) || estado?.state === 'blocked'
  }

  // Every acknowledged request owes a terminal answer. A run killed with the
  // process never produced one, so the next boot delivers it.
  async function recuperar() {
    for (const s of sessions.interrompidas()) {
      // One session's notice failing to deliver must not abort the loop and
      // silently skip every other interrupted session behind it.
      try {
        const { prompt, startedAt, bgId, sessionId } = s.pending
        const quando = ociosidade(startedAt)

        // Still running in claude's daemon, which a restart of this process
        // does not touch: wait for it like any other turn. Offering /retomar
        // here would run the same request a second time, alongside the first.
        // Checked before the transcript on purpose: a turn in progress can
        // already have written intermediate text, which is not its answer.
        if (await agenteVivo(bgId)) {
          await reply(`[${s.name}] Reiniciei no meio do seu pedido, mas ele continua rodando — mando a resposta quando terminar.`).catch(() => {})
          conduzir(s, (opcoes) => attach({ ...opcoes, bgId, sessionId: sessionId ?? s.claudeSessionId, sentAt: startedAt }), { avisou: true })
            .catch(() => {})
          continue
        }

        // The claude session runs detached from this process: the work may well
        // have finished while nobody was listening. Hand that over instead of
        // asking you to repeat a request that was already answered.
        const ultima = await sessions.lastReply?.(s.name).catch(() => null)
        if (ultima?.timestamp && Date.parse(ultima.timestamp) > Date.parse(startedAt)) {
          sessions.endRun(s.name)
          await responder(s.name, `(chegou enquanto eu reiniciava — é a última resposta da sessão)\n\n${ultima.content}`, s.cwd)
          continue
        }

        await reply([
          `[${s.name}] Este pedido foi interrompido por um reinício ${quando === 'agora' ? 'agora há pouco' : `há ${quando}`} e nunca terminou:`,
          '',
          `"${prompt}"`,
          '',
          `Manda /retomar ${s.name} pra eu refazer, ou /descartar ${s.name} pra esquecer.`,
        ].join('\n'))
      } catch {}
    }
  }

  const comandos = {
    async new(args) {
      const [dir, nome] = args
      try {
        const s = await sessions.create({ cwd: dir, name: nome })
        await reply(`Sessão [${s.name}] criada em ${s.cwd}`)
      } catch (err) {
        await reply(`Não deu: ${err.message}`)
      }
    },

    async ls() {
      const lista = sessions.list()
      if (!lista.length) return reply('Nenhuma sessão aberta. Manda /new pra criar uma.')
      const ativa = sessions.active()?.name
      const linhas = lista.map((s) => {
        const marca = s.name === ativa ? '*' : ' '
        const estado = s.busy ? 'ocupada' : `ociosa ${ociosidade(s.lastActivityAt)}`
        return `${marca} ${s.name}  ${s.cwd}  (${estado})`
      })
      return reply(linhas.join('\n'))
    },

    // Sessions started by hand (`claude` or `claude --bg`, outside the bot)
    // don't show up in /ls: sessions.js is the source of truth for what this
    // bot knows about, not the host. This is the window into the rest.
    async manuais() {
      if (!listAgents) return reply('Não consigo listar sessões do host agora.')
      const todas = await listAgents(config.claudeBin).catch(() => null)
      if (!todas) return reply('Não consegui listar as sessões do claude agora.')

      const conhecidas = new Set(sessions.list().map((s) => s.claudeSessionId).filter(Boolean))
      sessoesManuais = todas.filter((s) => s.sessionId && !conhecidas.has(s.sessionId))
      if (!sessoesManuais.length) return reply('Nenhuma sessão do claude fora do bot agora.')

      const linhas = sessoesManuais.map((s, i) => {
        const tipo = s.kind === 'interactive' ? 'interativa' : 'background'
        // `status` (busy/idle) só existe com processo vivo. Sem ele, `state`
        // é o que sobra — "done" é justamente o caso que já vimos travar de
        // formas imprevisíveis ao ser resumido (o processo já saiu de vez).
        const estado = s.status ?? s.state ?? '?'
        const risco = !s.status && s.state === 'done' ? ' — processo já saiu, resumir pode travar' : ''
        return `${i + 1}. ${s.name ?? '(sem nome)'} — ${s.cwd}  (${estado} · ${tipo})${risco}`
      })
      return reply(linhas.join('\n'))
    },

    async importar(args) {
      const indice = numeroDoRascunho(args[0])
      if (!indice) return reply('Uso: /importar <número> [nome] — os números vêm de /manuais.')
      const alvo = sessoesManuais[indice - 1]
      if (!alvo) return reply(`Não achei o número ${indice}. Manda /manuais de novo pra atualizar a lista.`)

      // Without a name, keep the one the session already had (sanitized to
      // what a session name may contain) instead of falling back straight to
      // s1/s2 — you picked it from the list because you recognized that name.
      const nome = args[1] || nomeSugerido(alvo.name)
      try {
        const s = sessions.create({ cwd: alvo.cwd, name: nome, claudeSessionId: alvo.sessionId })
        return reply(`Sessão [${s.name}] importada de ${s.cwd}. Ativa agora: [${s.name}].`)
      } catch (err) {
        return reply(`Não deu: ${err.message}`)
      }
    },

    async use(args) {
      const nome = args[0]
      if (!nome) return reply('Uso: /use <nome>')
      if (!sessions.setActive(nome)) return reply(`Não achei a sessão ${nome}.`)
      return reply(`Sessão ativa agora é [${nome}].`)
    },

    async cd(args, rest) {
      const dir = rest.trim()
      if (!dir) return reply('Uso: /cd <diretório> — muda a pasta da sessão ativa')
      const s = sessions.active()
      if (!s) return reply('Não há sessão ativa. Manda /new pra criar uma.')
      // Moving mid-turn would read the reply from the wrong folder, and a
      // pending interrupted request belongs to the conversation /cd discards.
      if (s.busy) return reply(`[${s.name}] está rodando agora — espera terminar ou manda /stop antes de trocar de pasta.`)
      if (s.pending) return reply(`[${s.name}] tem um pedido interrompido esperando você: manda /retomar ou /descartar antes de trocar de pasta.`)

      let r
      try {
        r = sessions.changeDir(s.name, dir)
      } catch (err) {
        return reply(`Não deu: ${err.message}`)
      }
      if (!r.changed) return reply(`[${s.name}] já está em ${r.cwd}.`)
      return reply(`[${s.name}] agora em ${r.cwd}. A conversa recomeça do zero aqui — o Claude guarda o histórico por pasta.`)
    },

    async end(args) {
      const nome = args[0] ?? sessions.active()?.name
      if (!nome) return reply('Não há sessão para encerrar.')
      let resultado
      try {
        resultado = await sessions.end(nome)
        if (!resultado) return reply(`Não achei a sessão ${nome}.`)
      } catch (err) {
        return reply(`Não deu: ${err.message}`)
      }
      const ativa = sessions.active()?.name
      const fila = resultado.queueDropped
        ? resultado.queueDropped > 1
          ? ` ${resultado.queueDropped} mensagens na fila foram descartadas.`
          : ' 1 mensagem na fila foi descartada.'
        : ''
      return reply(`Sessão [${nome}] encerrada.${fila}${ativa ? ` Ativa agora: [${ativa}].` : ''}`)
    },

    async stop() {
      const s = sessions.active()
      if (!s?.busy) return reply('Não tem nada rodando agora.')
      sessions.clearQueue(s.name)
      s.abort?.abort()
      return reply(`Interrompendo [${s.name}].`)
    },

    async retomar(args) {
      const alvo = args[0]
      const s = alvo ? sessions.get(alvo) : sessions.interrompidas()[0]
      if (alvo && !s) return reply(`Não achei a sessão ${alvo}.`)
      if (!s?.pending) return reply('Não tem nada interrompido para retomar.')

      const { prompt } = s.pending
      sessions.endRun(s.name)
      await reply(`Retomando [${s.name}].`)
      return despachar(s, prompt)
    },

    async descartar(args) {
      const alvo = args[0]
      const s = alvo ? sessions.get(alvo) : sessions.interrompidas()[0]
      if (alvo && !s) return reply(`Não achei a sessão ${alvo}.`)
      if (!s?.pending) return reply('Não tem nada interrompido para descartar.')

      sessions.endRun(s.name)
      return reply(`Esqueci o pedido interrompido de [${s.name}].`)
    },

    // Same as quoting a relayed reply, for when quoting is not handy.
    async r(args, rest) {
      if (!relay) return reply('Encaminhamento de respostas não está ligado.')
      const id = numeroDoRascunho(args[0])
      const texto = rest.slice(String(args[0] ?? '').length).trim()
      if (!id || !texto) return reply('Uso: /r <número> <sua resposta>')
      const linha = relay.porNumero(id)
      if (!linha) return reply(`Não achei a mensagem #${id}.`)
      return responderRelay(linha, texto)
    },

    async help() {
      return reply(AJUDA)
    },

    // The personal account lives in its own session so that a request about
    // your conversations never lands in whatever project session is active.
    async wpp(args, rest) {
      if (!semConta()) return
      const pedido = rest.trim()
      if (!pedido) return reply('Uso: /wpp <o que você quer que eu faça na sua conta>')

      let sessao
      try {
        sessao = await sessaoDoMordomo()
      } catch (err) {
        return reply(`Não deu: ${err.message}`)
      }
      return despachar(sessao, comContexto(pedido))
    },

    async ok(args) {
      return aprovar(args, 'me', '/ok')
    },

    // Same approval, but out of the bot's account instead of the owner's —
    // chosen here, at the moment of approving, not by whoever proposed it.
    async bot(args) {
      return aprovar(args, 'bot', '/bot')
    },

    // Correcting the wording used to mean discarding and asking again. The edit
    // lands back in `pending` on purpose: what goes out is what you approved.
    async edit(args, rest) {
      if (!semConta()) return
      const id = numeroDoRascunho(args[0])
      const texto = rest.slice(String(args[0] ?? '').length).trim()
      if (!id || !texto) return reply('Uso: /edit <número> <o texto novo>')

      let job
      try {
        job = wpp.outbox.edit(id, texto)
      } catch (err) {
        return reply(`Não deu: ${err.message}`)
      }
      if (!job) return reply(`Não achei rascunho editável #${id}. Manda /schedulers.`)

      return reply(formatDraft(job, wpp.timezone))
    },

    async no(args) {
      if (!semConta()) return
      const id = numeroDoRascunho(args[0])
      if (!id) return reply('Uso: /no <número do rascunho>')

      const job = wpp.outbox.reject(id) ?? wpp.outbox.cancel(id)
      if (!job) return reply(`Não achei nada aberto com o número #${id}.`)
      return reply(job.status === 'canceled' ? `Agendamento #${id} cancelado.` : `Rascunho #${id} descartado.`)
    },

    async schedulers() {
      if (!semConta()) return
      return reply(formatQueue({ pending: wpp.outbox.pending(), scheduled: wpp.outbox.scheduled() }, wpp.timezone))
    },

    async undo() {
      if (!semConta()) return
      const r = await wpp.undo()
      if (!r.ok) return reply(`Não deu pra desfazer: ${r.error}`)
      return reply(`Apaguei a mensagem para ${r.job.chat_name || r.job.chat_jid}: "${r.job.body}"`)
    },
  }

  async function aprovar(args, remetente, comando) {
    if (!semConta()) return
    const id = numeroDoRascunho(args[0])
    if (!id) return reply(`Uso: ${comando} <número do rascunho>`)

    // Through the bot it is always formal. A draft that came without a formal
    // version gets one now, before it is approved — if that fails, it is not
    // approved at all rather than going out in the owner's casual voice.
    if (remetente === 'bot') {
      const atual = wpp.outbox.get(id)
      if (atual?.status === 'pending' && !atual.body_bot && atual.body?.trim()) {
        if (!wpp.formalizar) return reply(`Não consigo formalizar #${id} agora — use /ok ou /edit.`)
        await reply(`Formalizando #${id} antes de mandar pelo bot…`)
        let formal
        try {
          formal = await wpp.formalizar({ nome: atual.chat_name, texto: atual.body, destino: atual.chat_jid })
        } catch (err) {
          return reply(`Não consegui formalizar #${id} (${err.message}) — nada foi enviado.`)
        }
        if (!formal) return reply(`A versão formal de #${id} veio vazia — nada foi enviado.`)
        wpp.outbox.setBodyBot(id, formal)
      }
    }

    const job = wpp.outbox.approve(id, remetente)
    if (!job) return reply(`Não achei rascunho pendente #${id}. Manda /schedulers.`)

    const como = remetente === 'bot' ? 'pelo bot' : 'como você'
    const texto = remetente === 'bot' && job.body_bot ? `\n\n"${job.body_bot}"` : ''
    await reply(job.scheduled_for ? `Aprovado ${como}. #${id} sai na hora marcada.${texto}` : `Aprovado, mandando #${id} ${como}.${texto}`)
    return wpp.tick()
  }

  // The butler: one long conversation that holds everything he says which is
  // not a command. A session with this name may predate it, or point somewhere
  // else entirely — anywhere but agentCwd and Claude never reads the
  // instructions that give it its tools and its rules.
  async function sessaoDoMordomo() {
    let sessao = sessions.get(SESSAO_WPP)
    if (sessao && (sessao.cwd !== wpp.agentCwd || instrucoesMudaram(sessao))) {
      sessions.end(SESSAO_WPP)
      sessao = null
    }
    return sessao ?? await sessions.create({ cwd: wpp.agentCwd, name: SESSAO_WPP, activate: false })
  }

  // A scheduled task come due: the assistant gets the sentence he wrote back,
  // in its own session, and answers him in the chat like any other turn. It is
  // framed so the assistant knows this is the hour arriving, not him asking.
  async function rodarTarefa({ id, prompt, label }) {
    const sessao = await sessaoDoMordomo()
    const cabecalho = `[tarefa agendada #${id}${label ? ` — ${label}` : ''}: chegou a hora. Faça o que ele pediu e responda em uma ou duas linhas, só o resultado.`
      + ` Se o que ele esperava já aconteceu e não faz mais sentido repetir, encerre com \`node act.mjs tarefa-fim --id ${id}\` e diga isso.]`
    return despachar(sessao, `${cabecalho}\n\n${prompt}`)
  }

  // A session on this host that he started himself, with that name. Sessions
  // the bot already tracks are skipped, and a `done` one is left alone: its
  // process is gone and resuming it has been seen to hang.
  async function doHost(nome) {
    if (!listAgents) return []
    const todas = await listAgents(config.claudeBin).catch(() => null)
    if (!todas) return []
    const minhas = new Set(sessions.list().flatMap((s) => [s.claudeSessionId, s.adotadaDe]).filter(Boolean))
    return todas.filter((a) => a.sessionId
      && !minhas.has(a.sessionId)
      && nomeSugerido(a.name) === nome
      && (a.status ? a.status !== 'done' : a.state !== 'done'))
  }

  // `@infra` means the `infra` he is looking at, not a namesake the bot
  // happens to have created. If one exists on the host, the name is pointed
  // at it — once, and it stays pointed there.
  async function sessaoChamada(nome) {
    const candidatas = await doHost(nome)
    if (candidatas.length > 1) {
      return { erro: [`Tem mais de uma sessão chamada ${nome} aberta neste host:`,
        ...candidatas.map((c) => `- ${c.cwd}`),
        'Renomeia uma delas, ou me diz a pasta.'].join('\n') }
    }
    if (candidatas.length === 1) {
      const alvo = candidatas[0]
      // The id has to be read before adopting: `adotar` mutates the very
      // object `get` returns, so comparing afterwards always says "unchanged".
      const registrada = sessions.get(nome)
      const idAntes = registrada?.claudeSessionId ?? null
      const sessao = sessions.adotar(nome, { cwd: alvo.cwd, claudeSessionId: alvo.sessionId, agenteId: alvo.id ?? null })
      const adotada = idAntes !== alvo.sessionId
      return { sessao, adotada }
    }
    const sessao = sessions.get(nome)
    return sessao ? { sessao } : { erro: `Não achei a sessão ${nome}. Manda /ls.` }
  }

  // The butler handing work to a project session, through the API. Same path
  // as a typed `@sessão`, so the reply reaches him labelled with that name.
  async function despacharDeFora({ session, prompt, cwd }) {
    let sessao = null
    if (session) {
      // Same resolution as `@nome`: the session he opened himself wins over a
      // namesake of the bot's own.
      const r = await sessaoChamada(session)
      if (r.erro) {
        if (!cwd) return { ok: false, error: typeof r.erro === 'string' ? r.erro : r.erro.split('\n')[0] }
      } else {
        sessao = r.sessao
      }
    } else {
      sessao = sessions.active()
    }
    if (sessao?.name === SESSAO_WPP) return { ok: false, error: 'essa é a sua própria sessão; despache para uma sessão de projeto' }

    const abrir = sessao
      ? Promise.resolve(sessao)
      : sessions.create({ cwd: cwd ?? config.defaultCwd, name: session ?? undefined })

    abrir
      .then((alvo) => despachar(alvo, prompt))
      .catch((e) => {
        log?.error?.(e.stack ?? e.message)
        reply(`Não consegui despachar para ${session ?? 'a sessão ativa'}: ${e.message}`).catch(() => {})
      })
    return { ok: true, session: sessao?.name ?? session ?? 'nova' }
  }

  function semConta() {
    if (wpp) return true
    reply('Conta pessoal não configurada. Veja o README para parear com `npm run pair:me`.').catch(() => {})
    return false
  }

  // Audio only exists to become text: transcribe, drop the file, then follow the
  // normal path — so /commands and @session work dictated, for free.
  async function textoDoAudio(caminho) {
    try {
      return await transcribe({
        path: caminho,
        apiKey: config.openaiApiKey,
        model: config.transcribeModel,
        timeoutMs: config.transcribeTimeoutMs,
      })
    } finally {
      rmSync(caminho, { force: true })
    }
  }

  async function responderRelay(linha, texto) {
    const r = await relay.answer(linha, texto)
    if (!r.ok) return reply(`Não mandei: ${r.error}`)
    return reply(`↪️ Mandei pelo bot para ${r.to}:\n\n${r.text}`)
  }

  const interpretar = classify && createIntent({ classify, ajuda: AJUDA, conhecidos: new Set(Object.keys(comandos)), log })

  function rodarComando(cmd) {
    const executor = comandos[cmd.name]
    if (!executor) return reply(`Não conheço /${cmd.name}. Manda /help.`)
    return executor(cmd.args, cmd.rest ?? '')
  }

  async function handle(entrada) {
    const { text, media, raw } = typeof entrada === 'string' ? { text: entrada, media: null, raw: null } : (entrada ?? {})

    if (media?.tooLarge) {
      return reply(`O arquivo ${media.fileName ?? ''} tem ${Math.round(media.size / 1024 / 1024)} MB — acima do limite que eu baixo. Compacta ou manda um pedaço.`)
    }

    let texto = text
    if (media?.kind === 'audio') {
      const r = await textoDoAudio(media.path)
      if (!r.ok) return reply(`Não consegui transcrever o áudio: ${r.error}`)
      texto = r.text
    }

    // Quoting a relayed reply answers that person; it is not a request for
    // Claude and never reaches a session.
    const citada = relay?.porCitacao(raw?.message?.extendedTextMessage?.contextInfo?.stanzaId)
    if (citada && texto?.trim()) return responderRelay(citada, texto.trim())

    const cmd = parse(texto)

    if (cmd.type === 'error') return reply(cmd.message)

    if (cmd.type === 'command') return rodarComando(cmd)

    // Plain words that mean a bot command run as that command — but only
    // where there is no butler. With one, two things would be reading the
    // same sentence and racing to act on it; the butler has every command as
    // a tool and the conversation to know what was meant, so it decides
    // alone, and he stops seeing "🗣️ Entendi: /comando" in front of his own
    // words.
    if (interpretar && !wpp && !cmd.target && (!media || media.kind === 'audio')) {
      const linha = await interpretar({
        texto: cmd.text,
        citada: textoCitado(raw),
        pendentes: wpp ? wpp.outbox.pending() : [],
      })
      if (linha) {
        await reply(`🗣️ Entendi: ${linha}`)
        return rodarComando(parse(linha))
      }
    }

    // Everything he says that is not a command is said to the butler, which
    // is the one that decides what it means — answering, writing to someone,
    // or handing the work to a project session. `@sessão` is how he reaches a
    // session directly, and without the personal account there is no butler,
    // so plain text keeps going to the active session as it always did.
    let sessao
    if (cmd.target) {
      const r = await sessaoChamada(cmd.target)
      if (r.erro) return reply(r.erro)
      sessao = r.sessao
      if (r.adotada) await reply(`(passei a usar a sua sessão ${sessao.name} de ${sessao.cwd})`)
    } else {
      try {
        sessao = wpp ? await sessaoDoMordomo() : (sessions.active() ?? await sessions.create({ cwd: config.defaultCwd }))
      } catch (err) {
        return reply(`Não deu: ${err.message}`)
      }
    }

    const prompt = media?.kind === 'image'
      ? promptComImagem(cmd.text, media.path)
      : media?.kind === 'document'
        ? promptComArquivo(cmd.text, media.path, media.fileName)
        : cmd.text
    return despachar(sessao, prompt)
  }

  return { handle, recuperar, despacharDeFora, rodarTarefa }
}
