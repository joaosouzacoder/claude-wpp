import { parse } from './router.js'
import { chunkText } from './text.js'

const AJUDA = [
  'Comandos:',
  '/new [dir] [nome] — cria sessão e ativa',
  '/ls — lista as sessões',
  '/use <nome> — troca a sessão ativa',
  '/end [nome] — encerra (sem nome, encerra a ativa)',
  '/stop — interrompe o que a sessão ativa está fazendo',
  '/help — isto aqui',
  '@nome texto — manda pra outra sessão sem trocar a ativa',
].join('\n')

function ociosidade(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min}min`
  return `${Math.floor(min / 60)}h`
}

export function createHandler({ sessions, run, reply, config }) {
  async function responder(nome, texto) {
    for (const pedaco of chunkText(texto, config.maxMessageChars)) {
      await reply(`[${nome}] ${pedaco}`)
    }
  }

  async function executar(sessao, prompt) {
    sessao.busy = true
    sessao.abort = new AbortController()
    let avisou = false

    try {
      const r = await run({
        bin: config.claudeBin,
        cwd: sessao.cwd,
        prompt,
        sessionId: sessao.claudeSessionId,
        slowNoticeMs: config.slowNoticeMs,
        timeoutMs: config.timeoutMs,
        signal: sessao.abort.signal,
        onSlow: () => {
          if (avisou) return
          avisou = true
          reply('Trabalhando nisso.').catch(() => {})
        },
      })

      if (r.sessionId) sessao.claudeSessionId = r.sessionId
      sessions.touch(sessao.name)

      await responder(sessao.name, r.ok ? r.text : `Erro: ${r.error}`)
    } finally {
      sessao.busy = false
      sessao.abort = null
    }

    const proxima = sessao.queue.shift()
    if (proxima != null) await executar(sessao, proxima)
  }

  async function despachar(sessao, prompt) {
    if (sessao.busy) {
      sessao.queue.push(prompt)
      return
    }
    await executar(sessao, prompt)
  }

  const comandos = {
    async new(args) {
      const [dir, nome] = args
      try {
        const s = sessions.create({ cwd: dir, name: nome })
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

    async use(args) {
      const nome = args[0]
      if (!nome) return reply('Uso: /use <nome>')
      if (!sessions.setActive(nome)) return reply(`Não achei a sessão ${nome}.`)
      return reply(`Sessão ativa agora é [${nome}].`)
    },

    async end(args) {
      const nome = args[0] ?? sessions.active()?.name
      if (!nome) return reply('Não há sessão para encerrar.')
      if (!sessions.end(nome)) return reply(`Não achei a sessão ${nome}.`)
      const ativa = sessions.active()?.name
      return reply(`Sessão [${nome}] encerrada.${ativa ? ` Ativa agora: [${ativa}].` : ''}`)
    },

    async stop() {
      const s = sessions.active()
      if (!s?.busy) return reply('Não tem nada rodando agora.')
      s.queue.length = 0
      s.abort?.abort()
      return reply(`Interrompendo [${s.name}].`)
    },

    async help() {
      return reply(AJUDA)
    },
  }

  async function handle(texto) {
    const cmd = parse(texto)

    if (cmd.type === 'error') return reply(cmd.message)

    if (cmd.type === 'command') {
      const executor = comandos[cmd.name]
      if (!executor) return reply(`Não conheço /${cmd.name}. Manda /help.`)
      return executor(cmd.args)
    }

    let sessao
    if (cmd.target) {
      sessao = sessions.get(cmd.target)
      if (!sessao) return reply(`Não achei a sessão ${cmd.target}. Manda /ls.`)
    } else {
      sessao = sessions.active() ?? sessions.create({ cwd: config.defaultCwd })
    }

    return despachar(sessao, cmd.text)
  }

  return { handle }
}
