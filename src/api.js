import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const LIMITE_BODY = 64 * 1024

function tokenConfere(recebido, esperado) {
  const a = Buffer.from(String(recebido ?? ''))
  const b = Buffer.from(String(esperado))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function lerBody(req) {
  return new Promise((resolve, reject) => {
    let dados = ''
    req.on('data', (pedaco) => {
      dados += pedaco
      if (dados.length > LIMITE_BODY) {
        reject(new Error('body grande demais'))
        req.destroy()
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
  personalState = null,
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
