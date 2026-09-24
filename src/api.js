import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { basename, sep } from 'node:path'
import { mimetypeDe } from './mimetypes.js'
import { pareceNumero } from './contacts.js'
import { jidDe } from './whatsapp.js'
import { saveMedia } from './media.js'

export { mimetypeDe }

const LIMITE_BODY = 64 * 1024
// A file travels base64-encoded inside the JSON, a third bigger than itself:
// this admits files up to roughly 16 MB.
const LIMITE_BODY_ARQUIVO = 24 * 1024 * 1024
const NOME_ARQUIVO_MAX = 200
// How long a /wpp request's permission to send directly waits for the draft
// it produces. A run that takes longer lands as an ordinary draft.
const LIBERACAO_MS = 30 * 60 * 1000
const REMETENTES_DIRETOS = new Set(['me', 'bot'])
const LIBERACOES_MAX = 20

// The name is only what the phone displays, but it arrives from the caller:
// a bare file name, never a path.
export function nomeDeArquivoValido(nome) {
  return typeof nome === 'string'
    && nome.length > 0
    && nome.length <= NOME_ARQUIVO_MAX
    && !/[/\\\0]/.test(nome)
    && nome !== '.'
    && nome !== '..'
}

// Buffer.from(x, 'base64') silently skips characters it does not recognize,
// so garbage would decode into a corrupted file instead of an error.
export function decodificarBase64(texto) {
  if (typeof texto !== 'string') return null
  const limpo = texto.replace(/\s+/g, '')
  if (!limpo || limpo.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(limpo)) return null
  return Buffer.from(limpo, 'base64')
}

function tokenConfere(recebido, esperado) {
  const a = Buffer.from(String(recebido ?? ''))
  const b = Buffer.from(String(esperado))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

class BodyGrandeDemais extends Error {}

function lerBody(req, limite = LIMITE_BODY) {
  return new Promise((resolve, reject) => {
    let dados = ''
    let estourou = false
    req.on('data', (pedaco) => {
      if (estourou) return
      dados += pedaco
      if (dados.length > limite) {
        // Keep draining instead of destroying the socket: destroying it here
        // cuts the connection before the caller ever sees the error response.
        // Only authenticated callers get this far.
        estourou = true
        dados = ''
        reject(new BodyGrandeDemais('body grande demais'))
      }
    })
    req.on('end', () => resolve(dados))
    req.on('error', reject)
  })
}

export function createApi({
  host, port, token, whatsapp,
  sessionCount = () => 0,
  outbox = null,
  onDraft = null,
  onDirect = null,
  onWpp = null,
  onDispatch = null,
  onUndo = null,
  tasks = null,
  sessionList = () => [],
  personalState = null,
  notifier = null,
  contacts = null,
  mediaDir = null,
  now = Date.now,
}) {
  const json = (res, status, corpo) => {
    const texto = JSON.stringify(corpo)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(texto) })
    res.end(texto)
  }

  // `to` is a number or a contact name. A name is resolved against the
  // personal account's chats and only ever to exactly one of them: a guess
  // would deliver to the wrong person, so ambiguity comes back as candidates
  // for the caller to narrow down.
  const resolverDestino = (to) => {
    if (pareceNumero(to)) return { destino: String(to) }
    if (!contacts) return { erro: [400, { ok: false, error: 'para mandar por nome, a conta pessoal precisa estar pareada; passe o número' }] }
    const r = contacts.resolve(String(to))
    if (r.ok) return { destino: r.jid, nome: r.name }
    if (r.motivo === 'ambiguo') {
      return { erro: [409, { ok: false, error: `"${to}" bate com mais de um contato; seja mais específico`, candidates: r.candidatos }] }
    }
    return { erro: [404, { ok: false, error: `não achei nenhum contato chamado "${to}"` }] }
  }

  // A draft names a file by path, and the bot will read and send it. Only a
  // file under the media directory — where /wpp and /send-file put what they
  // were given — may be named: otherwise holding the token would be a way to
  // mail any file on this host out, one /ok away. Resolved through symlinks.
  const anexoDaPastaDeMidia = (anexo) => {
    if (!mediaDir || typeof anexo?.path !== 'string') return null
    let real
    let base
    try {
      real = realpathSync(anexo.path)
      base = realpathSync(mediaDir)
      if (!statSync(real).isFile()) return null
    } catch {
      return null
    }
    if (!real.startsWith(base + sep)) return null
    const name = nomeDeArquivoValido(anexo.name) ? anexo.name : basename(real)
    return { path: real, name, mimetype: mimetypeDe(name) }
  }

  // A /wpp request sent with `send` lets the draft it produces go out without
  // the owner's /ok — once, as that sender, for a limited time. The grant
  // lives here, not in the session's instructions: the session reads other
  // people's messages, and a message telling it to send directly must not be
  // enough. Without a grant, a direct send lands as an ordinary draft.
  const liberacoes = []
  const liberar = (sender) => {
    liberacoes.push({ sender, expiraEm: now() + LIBERACAO_MS })
    if (liberacoes.length > LIBERACOES_MAX) liberacoes.shift()
  }
  const consumirLiberacao = (sender) => {
    const agora = now()
    for (let i = liberacoes.length - 1; i >= 0; i--) if (liberacoes[i].expiraEm <= agora) liberacoes.splice(i, 1)
    const i = liberacoes.findIndex((l) => l.sender === sender)
    if (i === -1) return false
    liberacoes.splice(i, 1)
    return true
  }

  // `confirm: true` on /send or /send-file: nothing goes out here. The message
  // becomes a draft, the owner sees it on WhatsApp, and decides there — /ok as
  // himself, /bot as the bot, /no to drop it.
  const criarRascunho = async (res, alvo, { body, attachment = null }) => {
    let rascunho
    try {
      rascunho = outbox.create({ chatJid: jidDe(alvo.destino), chatName: alvo.nome ?? null, body, attachment })
    } catch (err) {
      return json(res, 400, { ok: false, error: err.message })
    }
    try {
      await onDraft?.(rascunho)
    } catch {
      // Losing the notification must not lose the draft; /schedulers finds it.
    }
    return json(res, 202, { ok: true, draft: rascunho.id, ...(alvo.nome ? { to: alvo.nome } : {}) })
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'método não permitido' })
      return json(res, 200, {
        ok: true,
        wa: whatsapp.state(),
        sessions: sessionCount(),
        ...(personalState ? { me: personalState(), pending: outbox?.pending().length ?? 0 } : {}),
      })
    }

    const autorizado = () => {
      const cabecalho = req.headers.authorization ?? ''
      return tokenConfere(cabecalho.replace(/^Bearer\s+/i, ''), token)
    }

    // Claude proposes here and stops: the row lands as `pending` and only an
    // explicit /ok or /bot on WhatsApp releases it. The one exception is
    // `sendAs`, and only while a /wpp request's grant for it is open.
    if (url.pathname === '/outbox') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      if (!outbox) return json(res, 503, { ok: false, error: 'conta pessoal não configurada' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req))
      } catch {
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      let anexo = null
      if (corpo?.attachment) {
        anexo = anexoDaPastaDeMidia(corpo.attachment)
        if (!anexo) return json(res, 400, { ok: false, error: 'anexo precisa ser um arquivo da pasta de mídia do claude-wpp' })
      }

      const { sendAs, ...campos } = corpo ?? {}
      if (sendAs != null && !REMETENTES_DIRETOS.has(sendAs)) return json(res, 400, { ok: false, error: 'sendAs tem que ser "me" ou "bot"' })
      // Through the bot it is always the formal wording; with no one to ask,
      // there is no /bot step left to formalize it later.
      if (sendAs === 'bot' && !String(campos.bodyBot ?? '').trim()) return json(res, 400, { ok: false, error: 'sendAs "bot" exige bodyBot' })

      let rascunho
      try {
        rascunho = outbox.create({ ...campos, attachment: anexo })
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message })
      }

      if (sendAs && consumirLiberacao(sendAs)) {
        const aprovado = outbox.approve(rascunho.id, sendAs)
        try {
          await onDirect?.(aprovado)
        } catch {
          // Approved is approved: the scheduler sends it on its next pass.
        }
        return json(res, 200, { ok: true, id: aprovado.id, status: aprovado.status, sent: sendAs })
      }

      try {
        await onDraft?.(rascunho)
      } catch {
        // Losing the notification must not lose the draft; /schedulers finds it.
      }
      return json(res, 200, {
        ok: true, id: rascunho.id, status: rascunho.status,
        ...(sendAs ? { warning: 'envio direto não autorizado para este pedido; ficou como rascunho esperando /ok ou /bot' } : {}),
      })
    }

    // The same door as `/wpp` typed on WhatsApp, for the machines that are not
    // this one. The draft it produces waits for an `/ok` like every other,
    // unless the caller sent `send`: then that one draft may go out directly.
    if (url.pathname === '/wpp') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      if (!onWpp) return json(res, 503, { ok: false, error: 'conta pessoal não configurada' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req, LIMITE_BODY_ARQUIVO))
      } catch (err) {
        if (err instanceof BodyGrandeDemais) return json(res, 413, { ok: false, error: 'arquivo grande demais (máx. ~16 MB)' })
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      let pedido = String(corpo?.request ?? '').trim()
      if (!pedido) return json(res, 400, { ok: false, error: 'request é obrigatório' })
      const envio = corpo.send ?? null
      if (envio != null && !REMETENTES_DIRETOS.has(envio)) return json(res, 400, { ok: false, error: 'send tem que ser "me" ou "bot"' })

      // A file to go with the message: kept under the media directory, and
      // the session is told where, so the draft it proposes carries it.
      if (corpo.attachment) {
        const { fileName, content } = corpo.attachment
        if (!nomeDeArquivoValido(fileName)) return json(res, 400, { ok: false, error: 'attachment.fileName inválido: um nome de arquivo, sem caminho' })
        const bytes = decodificarBase64(content)
        if (!bytes) return json(res, 400, { ok: false, error: 'attachment.content tem que ser o arquivo em base64' })
        if (!mediaDir) return json(res, 503, { ok: false, error: 'pasta de mídia não configurada' })
        const caminho = saveMedia({ dir: mediaDir, buffer: bytes, mimetype: mimetypeDe(fileName), kind: 'document', fileName })
        pedido += `\n\n[arquivo para anexar ao rascunho: "${fileName}" em ${caminho} — passe --attach '${caminho}' --attach-name '${fileName}' ao propose.mjs]`
      }

      // A run takes as long as Claude takes, and reports on WhatsApp when it is
      // done. Holding the connection open for that would only ever time out.
      if (envio) {
        liberar(envio)
        pedido += `\n\n[envio direto autorizado ${envio === 'me' ? 'como o dono da conta' : 'pelo bot'}: se destino e conteúdo estão claros, passe --send-as ${envio} ao propose.mjs e a mensagem sai sem esperar aprovação; se houver qualquer dúvida, proponha um rascunho normal]`
      }

      onWpp(pedido)
      return json(res, 202, { ok: true, queued: true, ...(envio ? { send: envio } : {}) })
    }

    // The butler's own hands. It already proposes through /outbox; these are
    // the rest of what it needs to act on what the owner tells it in words —
    // release a draft, take one back, hand work to a project session — without
    // him having to type the command himself.
    if (url.pathname === '/approve') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      if (!outbox) return json(res, 503, { ok: false, error: 'conta pessoal não configurada' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req))
      } catch {
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      const id = Number(corpo?.id)
      const sender = corpo?.sender ?? 'me'
      if (!Number.isInteger(id) || id <= 0) return json(res, 400, { ok: false, error: 'id é obrigatório' })
      if (!REMETENTES_DIRETOS.has(sender)) return json(res, 400, { ok: false, error: 'sender tem que ser "me" ou "bot"' })

      const atual = outbox.get(id)
      if (!atual || atual.status !== 'pending') return json(res, 404, { ok: false, error: `não há rascunho pendente #${id}` })
      if (sender === 'bot' && !String(atual.body_bot ?? '').trim()) {
        return json(res, 400, { ok: false, error: `#${id} não tem versão formal; mande pelo /outbox com bodyBot ou aprove como "me"` })
      }

      const aprovado = outbox.approve(id, sender)
      try {
        await onDirect?.(aprovado)
      } catch {
        // Approved is approved: the scheduler sends it on its next pass.
      }
      return json(res, 200, { ok: true, id, status: aprovado.status, sent: sender })
    }

    if (url.pathname === '/undo') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      if (!onUndo) return json(res, 503, { ok: false, error: 'conta pessoal não configurada' })

      const r = await onUndo()
      if (!r.ok) return json(res, 409, { ok: false, error: r.error })
      return json(res, 200, { ok: true, to: r.job.chat_name ?? r.job.chat_jid, body: r.job.body })
    }

    // Something to happen again, or later. The assistant used to improvise
    // this with the host's crontab, where nothing could say afterwards what
    // was scheduled or stop it going wrong quietly.
    if (url.pathname === '/tasks') {
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      if (!tasks) return json(res, 503, { ok: false, error: 'agenda não configurada' })

      if (req.method === 'GET') {
        return json(res, 200, { ok: true, tasks: tasks.list() })
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req))
      } catch {
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      let tarefa
      try {
        tarefa = tasks.create({ prompt: corpo?.prompt, label: corpo?.label ?? null, dailyAt: corpo?.dailyAt ?? null, at: corpo?.at ?? null })
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message })
      }
      return json(res, 200, { ok: true, id: tarefa.id, nextRun: tarefa.next_run, dailyAt: tarefa.daily_at })
    }

    if (url.pathname === '/tasks/close') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      if (!tasks) return json(res, 503, { ok: false, error: 'agenda não configurada' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req))
      } catch {
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      const id = Number(corpo?.id)
      if (!Number.isInteger(id) || id <= 0) return json(res, 400, { ok: false, error: 'id é obrigatório' })
      const tarefa = corpo?.done === true ? tasks.finish(id) : tasks.cancel(id)
      if (!tarefa) return json(res, 404, { ok: false, error: `não há tarefa ativa #${id}` })
      return json(res, 200, { ok: true, id, status: tarefa.status })
    }

    if (url.pathname === '/sessions') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      return json(res, 200, { ok: true, sessions: sessionList() })
    }

    if (url.pathname === '/dispatch') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      if (!onDispatch) return json(res, 503, { ok: false, error: 'despacho não configurado' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req))
      } catch {
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      const prompt = String(corpo?.prompt ?? '').trim()
      const sessao = String(corpo?.session ?? '').trim()
      if (!prompt) return json(res, 400, { ok: false, error: 'prompt é obrigatório' })

      const r = await onDispatch({ session: sessao || null, prompt, cwd: String(corpo?.cwd ?? '').trim() || null })
      if (!r.ok) return json(res, 400, { ok: false, error: r.error })
      // The session answers on WhatsApp on its own clock, labelled with its
      // name; holding this connection open for a build would only time out.
      return json(res, 202, { ok: true, session: r.session, queued: true })
    }

    // Always to the owner, unlike /send: an alert has exactly one reader, and
    // the caller should not have to know or carry that number.
    if (url.pathname === '/notify') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      if (!notifier) return json(res, 503, { ok: false, error: 'notificações não configuradas' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req))
      } catch {
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      const text = typeof corpo?.text === 'string' ? corpo.text.trim() : ''
      if (!text) return json(res, 400, { ok: false, error: 'text é obrigatório' })
      const source = typeof corpo?.source === 'string' && corpo.source.trim() ? corpo.source.trim() : null
      const key = typeof corpo?.key === 'string' && corpo.key ? corpo.key : null

      let r
      try {
        r = await notifier.notify({ text, source, key })
      } catch (err) {
        return json(res, 502, { ok: false, error: err.message })
      }
      return json(res, 200, { ok: true, sent: r.sent, deduped: r.deduped })
    }

    // Like /send — as the bot, immediately — but a file instead of text.
    if (url.pathname === '/send-file') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req, LIMITE_BODY_ARQUIVO))
      } catch (err) {
        if (err instanceof BodyGrandeDemais) return json(res, 413, { ok: false, error: 'arquivo grande demais (máx. ~16 MB)' })
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      const { to, fileName, content, caption, mimetype } = corpo ?? {}
      if (!to) return json(res, 400, { ok: false, error: 'to é obrigatório' })
      if (!nomeDeArquivoValido(fileName)) return json(res, 400, { ok: false, error: 'fileName inválido: um nome de arquivo, sem caminho' })
      const bytes = decodificarBase64(content)
      if (!bytes) return json(res, 400, { ok: false, error: 'content tem que ser o arquivo em base64' })
      const alvo = resolverDestino(to)
      if (alvo.erro) return json(res, ...alvo.erro)
      const legenda = typeof caption === 'string' && caption ? caption : undefined
      const tipo = typeof mimetype === 'string' && mimetype ? mimetype : mimetypeDe(fileName)

      if (corpo.confirm === true) {
        if (!outbox || !mediaDir) return json(res, 503, { ok: false, error: 'rascunho exige a conta pessoal pareada' })
        const caminho = saveMedia({ dir: mediaDir, buffer: bytes, mimetype: tipo, kind: 'document', fileName })
        return criarRascunho(res, alvo, { body: legenda ?? '', attachment: { path: caminho, name: fileName, mimetype: tipo } })
      }

      try {
        await whatsapp.sendDocument(alvo.destino, { content: bytes, fileName, caption: legenda, mimetype: tipo })
      } catch (err) {
        return json(res, 502, { ok: false, error: err.message })
      }
      return json(res, 200, { ok: true, bytes: bytes.length, ...(alvo.nome ? { to: alvo.nome } : {}) })
    }

    if (url.pathname === '/send') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req))
      } catch {
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      const { to, text } = corpo ?? {}
      if (!to || !text) return json(res, 400, { ok: false, error: 'to e text são obrigatórios' })
      const alvo = resolverDestino(to)
      if (alvo.erro) return json(res, ...alvo.erro)

      if (corpo.confirm === true) {
        if (!outbox) return json(res, 503, { ok: false, error: 'rascunho exige a conta pessoal pareada' })
        return criarRascunho(res, alvo, { body: String(text) })
      }

      try {
        await whatsapp.sendText(alvo.destino, String(text))
      } catch (err) {
        return json(res, 502, { ok: false, error: err.message })
      }
      return json(res, 200, { ok: true, ...(alvo.nome ? { to: alvo.nome } : {}) })
    }

    return json(res, 404, { ok: false, error: 'não encontrado' })
  })

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve(server.address().port))
      })
    },
    close() {
      return new Promise((resolve) => {
        // Without this, close() waits on idle keep-alive sockets and the
        // shutdown on SIGTERM never finishes.
        server.closeAllConnections()
        server.close(resolve)
      })
    },
  }
}
