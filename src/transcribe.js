import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions'

async function motivoDoErro(resposta) {
  try {
    const corpo = await resposta.json()
    const msg = corpo?.error?.message
    if (msg) return String(msg)
  } catch {
    // no json body — the status code already says enough
  }
  return `a OpenAI respondeu ${resposta.status}`
}

export async function transcribe({
  path,
  apiKey,
  model = 'gpt-4o-transcribe',
  timeoutMs = 120000,
  fetchImpl = fetch,
} = {}) {
  const falha = (error) => ({ ok: false, text: '', error })

  if (!apiKey) return falha('não há chave da OpenAI configurada')

  let bytes
  try {
    bytes = readFileSync(path)
  } catch (err) {
    return falha(`não consegui ler o áudio: ${err.message}`)
  }

  const form = new FormData()
  form.append('file', new Blob([bytes]), basename(path))
  form.append('model', model)

  let resposta
  try {
    resposta = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      return falha(`passei do tempo limite (${Math.round(timeoutMs / 1000)}s) esperando a transcrição`)
    }
    return falha(err?.message ?? String(err))
  }

  if (!resposta.ok) return falha(await motivoDoErro(resposta))

  let corpo
  try {
    corpo = await resposta.json()
  } catch (err) {
    return falha(`não entendi a resposta da OpenAI: ${err.message}`)
  }

  const texto = String(corpo?.text ?? '').trim()
  if (!texto) return falha('a transcrição voltou vazia')

  return { ok: true, text: texto, error: null }
}
