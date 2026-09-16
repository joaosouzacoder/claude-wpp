import { rmSync } from 'node:fs'
import { parse } from './router.js'
import { chunkText } from './text.js'
import { promptComImagem } from './media.js'
import { formatDraft, formatQueue } from './wpp.js'

const SESSAO_WPP = 'wpp'

const AJUDA = [
  'Comandos:',
  '/new [dir] [nome] — cria sessão e ativa',
  '/ls — lista as sessões',
  '/manuais — lista sessões do claude neste host que o bot não controla',
  '/importar <n> [nome] — adota a sessão n da lista de /manuais',
  '/use <nome> — troca a sessão ativa',
  '/end [nome] — encerra (sem nome, encerra a ativa)',
  '/stop — interrompe o que a sessão ativa está fazendo',
  '/retomar [nome] — refaz o pedido que morreu num reinício',
  '/descartar [nome] — esquece o pedido que morreu num reinício',
  '/help — isto aqui',
  '@nome texto — manda pra outra sessão sem trocar a ativa',
  '',
  'Sua conta pessoal:',
  '/wpp <pedido> — lê suas conversas e prepara uma mensagem',
  '/ok <n> — aprova o rascunho n (só assim ele sai)',
  '/edit <n> <texto> — reescreve o rascunho n (volta a precisar de /ok)',
  '/no <n> — descarta o rascunho ou cancela o agendamento n',
  '/schedulers — o que espera seu ok e o que está agendado',
  '/undo — apaga a última mensagem que mandei por você',
  '',
  'Áudio vira texto e segue como se você tivesse digitado (comandos inclusive).',
  'Imagem vai junto do pedido; a legenda é o prompt.',
].join('\n')

// Accepts "3", "#3" and "d3" — you are typing this on a phone.
function numeroDoRascunho(bruto) {
  const digitos = String(bruto ?? '').replace(/[^0-9]/g, '')
  return digitos ? Number(digitos) : null
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

export function createHandler({ sessions, run, transcribe, reply, config, wpp = null, listAgents = null }) {
  // What /manuais last showed, so /importar <n> knows which session that
  // number meant. Only ever read right after a fresh /manuais.
  let sessoesManuais = []

  async function responder(nome, texto) {
    for (const pedaco of chunkText(texto, config.maxMessageChars)) {
      await reply(`[${nome}] ${pedaco}`)
    }
  }

  async function executar(sessao, prompt) {
    // On disk before the first token: if this process dies mid-run, the next
    // boot is the only thing left that can tell you the reply is owed.
    sessions.beginRun(sessao.name, prompt)
    sessao.busy = true
    sessao.abort = new AbortController()
    let avisou = false

    try {
      const r = await run({
        bin: config.claudeBin,
        name: sessao.name,
        cwd: sessao.cwd,
        prompt,
        sessionId: sessao.claudeSessionId,
        slowNoticeMs: config.slowNoticeMs,
        heartbeatMs: config.heartbeatMs,
        timeoutMs: config.timeoutMs,
        signal: sessao.abort.signal,
        onSlow: (decorrido) => {
          const texto = avisou
            ? `Ainda trabalhando nisso (${duracao(decorrido)}).`
            : 'Trabalhando nisso.'
          avisou = true
          reply(texto).catch(() => {})
        },
        onNotice: (texto) => { reply(`[${sessao.name}] ${texto}`).catch(() => {}) },
      })

      if (r.sessionId) sessao.claudeSessionId = r.sessionId
      sessions.touch(sessao.name)

      await responder(sessao.name, r.ok ? r.text : `Erro: ${r.error}`)
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
    await executar(sessao, prompt)
  }

  // Every acknowledged request owes a terminal answer. A run killed with the
  // process never produced one, so the next boot delivers it.
  async function recuperar() {
    for (const s of sessions.interrompidas()) {
      const { prompt, startedAt } = s.pending
      const quando = ociosidade(startedAt)

      // The claude session runs detached from this process: the work may well
      // have finished while nobody was listening. Hand that over instead of
      // asking you to repeat a request that was already answered.
      const ultima = await sessions.lastReply?.(s.name).catch(() => null)
      if (ultima?.timestamp && Date.parse(ultima.timestamp) > Date.parse(startedAt)) {
        sessions.endRun(s.name)
        await responder(s.name, `(chegou enquanto eu reiniciava — é a última resposta da sessão)\n\n${ultima.content}`)
        continue
      }

      await reply([
        `[${s.name}] Este pedido foi interrompido por um reinício ${quando === 'agora' ? 'agora há pouco' : `há ${quando}`} e nunca terminou:`,
        '',
        `"${prompt}"`,
        '',
        `Manda /retomar ${s.name} pra eu refazer, ou /descartar ${s.name} pra esquecer.`,
      ].join('\n'))
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
        return `${i + 1}. ${s.name ?? '(sem nome)'} — ${s.cwd}  (${s.status ?? '?'} · ${tipo})`
      })
      return reply(linhas.join('\n'))
    },

    async importar(args) {
      const indice = numeroDoRascunho(args[0])
      if (!indice) return reply('Uso: /importar <número> [nome] — os números vêm de /manuais.')
      const alvo = sessoesManuais[indice - 1]
      if (!alvo) return reply(`Não achei o número ${indice}. Manda /manuais de novo pra atualizar a lista.`)

      try {
        const s = sessions.create({ cwd: alvo.cwd, name: args[1], claudeSessionId: alvo.sessionId })
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

    async end(args) {
      const nome = args[0] ?? sessions.active()?.name
      if (!nome) return reply('Não há sessão para encerrar.')
      try {
        if (!(await sessions.end(nome))) return reply(`Não achei a sessão ${nome}.`)
      } catch (err) {
        return reply(`Não deu: ${err.message}`)
      }
      const ativa = sessions.active()?.name
      return reply(`Sessão [${nome}] encerrada.${ativa ? ` Ativa agora: [${ativa}].` : ''}`)
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

    async help() {
      return reply(AJUDA)
    },

    // The personal account lives in its own session so that a request about
    // your conversations never lands in whatever project session is active.
    async wpp(args, rest) {
      if (!semConta()) return
      const pedido = rest.trim()
      if (!pedido) return reply('Uso: /wpp <o que você quer que eu faça na sua conta>')

      // A session with this name may predate the command, or point somewhere
      // else entirely. Pointing anywhere but agentCwd means Claude never reads
      // the instructions that give it its tools and its one rule.
      let sessao = sessions.get(SESSAO_WPP)
      if (sessao && sessao.cwd !== wpp.agentCwd) {
        sessions.end(SESSAO_WPP)
        sessao = null
      }
      try {
        sessao ??= await sessions.create({ cwd: wpp.agentCwd, name: SESSAO_WPP, activate: false })
      } catch (err) {
        return reply(`Não deu: ${err.message}`)
      }
      return despachar(sessao, pedido)
    },

    async ok(args) {
      if (!semConta()) return
      const id = numeroDoRascunho(args[0])
      if (!id) return reply('Uso: /ok <número do rascunho>')

      const job = wpp.outbox.approve(id)
      if (!job) return reply(`Não achei rascunho pendente #${id}. Manda /schedulers.`)

      await reply(job.scheduled_for ? `Aprovado. #${id} sai na hora marcada.` : `Aprovado, mandando #${id}.`)
      return wpp.tick()
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

  async function handle(entrada) {
    const { text, media } = typeof entrada === 'string' ? { text: entrada, media: null } : (entrada ?? {})

    let texto = text
    if (media?.kind === 'audio') {
      const r = await textoDoAudio(media.path)
      if (!r.ok) return reply(`Não consegui transcrever o áudio: ${r.error}`)
      texto = r.text
    }

    const cmd = parse(texto)

    if (cmd.type === 'error') return reply(cmd.message)

    if (cmd.type === 'command') {
      const executor = comandos[cmd.name]
      if (!executor) return reply(`Não conheço /${cmd.name}. Manda /help.`)
      return executor(cmd.args, cmd.rest ?? '')
    }

    let sessao
    if (cmd.target) {
      sessao = sessions.get(cmd.target)
      if (!sessao) return reply(`Não achei a sessão ${cmd.target}. Manda /ls.`)
    } else {
      try {
        sessao = sessions.active() ?? await sessions.create({ cwd: config.defaultCwd })
      } catch (err) {
        return reply(`Não deu: ${err.message}`)
      }
    }

    const prompt = media?.kind === 'image' ? promptComImagem(cmd.text, media.path) : cmd.text
    return despachar(sessao, prompt)
  }

  return { handle, recuperar }
}
