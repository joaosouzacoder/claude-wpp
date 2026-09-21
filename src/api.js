import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { mimetypeDe } from './mimetypes.js'

export { mimetypeDe }

const LIMITE_BODY = 64 * 1024
// A file travels base64-encoded inside the JSON, a third bigger than itself:
// this admits files up to roughly 16 MB.
const LIMITE_BODY_ARQUIVO = 24 * 1024 * 1024
const NOME_ARQUIVO_MAX = 200

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
  onWpp = null,
  personalState = null,
  notifier = null,
}) {
  const json = (res, status, corpo) => {
    const texto = JSON.stringify(corpo)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(texto) })
    res.end(texto)
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

    // Claude proposes here and stops. Nothing on this path sends anything: the
    // row lands as `pending` and only an explicit /ok on WhatsApp releases it.
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

      let rascunho
      try {
        rascunho = outbox.create(corpo ?? {})
      } catch (err) {
        return json(res, 400, { ok: false, error: err.message })
      }

      try {
        await onDraft?.(rascunho)
      } catch {
        // Losing the notification must not lose the draft; /schedulers finds it.
      }
      return json(res, 200, { ok: true, id: rascunho.id, status: rascunho.status })
    }

    // The same door as `/wpp` typed on WhatsApp, for the machines that are not
    // this one. It still only proposes: the draft it produces waits for an `/ok`
    // like every other, and the answer lands on WhatsApp — which is where that
    // `/ok` has to be typed anyway.
    if (url.pathname === '/wpp') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })
      if (!autorizado()) return json(res, 401, { ok: false, error: 'não autorizado' })
      if (!onWpp) return json(res, 503, { ok: false, error: 'conta pessoal não configurada' })

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req))
      } catch {
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      const pedido = String(corpo?.request ?? '').trim()
      if (!pedido) return json(res, 400, { ok: false, error: 'request é obrigatório' })

      // A run takes as long as Claude takes, and reports on WhatsApp when it is
      // done. Holding the connection open for that would only ever time out.
      onWpp(pedido)
      return json(res, 202, { ok: true, queued: true })
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

      try {
        await whatsapp.sendDocument(String(to), {
          content: bytes,
          fileName,
          caption: typeof caption === 'string' && caption ? caption : undefined,
          mimetype: typeof mimetype === 'string' && mimetype ? mimetype : mimetypeDe(fileName),
        })
      } catch (err) {
        return json(res, 502, { ok: false, error: err.message })
      }
      return json(res, 200, { ok: true, bytes: bytes.length })
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

      try {
        await whatsapp.sendText(String(to), String(text))
      } catch (err) {
        return json(res, 502, { ok: false, error: err.message })
      }
      return json(res, 200, { ok: true })
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
