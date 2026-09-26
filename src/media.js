import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'

const EXTENSOES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/3gpp': '3gp',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
}

const PADRAO_POR_TIPO = { image: 'jpg', audio: 'ogg', video: 'mp4' }

const PEDIDO_PADRAO = 'Analise a imagem anexada.'
const PEDIDO_ARQUIVO_PADRAO = 'Analise o arquivo anexado.'

// WhatsApp sends the mimetype with parameters ("audio/ogg; codecs=opus").
function extensao(mimetype, kind) {
  const base = String(mimetype ?? '').split(';')[0].trim().toLowerCase()
  return EXTENSOES[base] ?? PADRAO_POR_TIPO[kind] ?? 'bin'
}

// The sender's file name comes from the phone: kept only as a readable
// suffix, stripped of anything that could make it a path.
function nomeSeguro(nome) {
  return String(nome ?? '').replace(/[/\\\0]/g, '_').replace(/^\.+/, '').slice(-120)
}

export function saveMedia({ dir, buffer, mimetype, kind, fileName = null }) {
  mkdirSync(dir, { recursive: true })
  const prefixo = `${Date.now()}-${randomUUID().slice(0, 8)}`
  // A document keeps its own name (and so its extension, which is what tells
  // Claude how to open it); mimetypes of documents are too many to map.
  const nome = kind === 'document' && nomeSeguro(fileName)
    ? `${prefixo}-${nomeSeguro(fileName)}`
    : `${prefixo}.${extensao(mimetype, kind)}`
  const caminho = join(dir, nome)
  writeFileSync(caminho, buffer)
  return caminho
}

export function promptComImagem(legenda, caminho) {
  const texto = String(legenda ?? '').trim() || PEDIDO_PADRAO
  return `${texto}\n\n[imagem anexada em ${caminho} — leia o arquivo para respondê-la]`
}

const MARCA_ARQUIVO = /^[ \t]*\[\[arquivo:[ \t]*(.+?)[ \t]*\]\][ \t]*(?:\r?\n|$)/gm

// Pulls the `[[arquivo: path]]` lines Claude writes (see FORMATO_WHATSAPP in
// handler.js) out of a reply. A relative path is resolved from the session's
// folder, where Claude ran; `~` from the home directory.
export function extrairArquivos(texto, cwd) {
  const arquivos = []
  const limpo = String(texto ?? '').replace(MARCA_ARQUIVO, (_, bruto) => {
    const expandido = bruto === '~' ? homedir() : bruto.replace(/^~\//, `${homedir()}/`)
    const caminho = resolve(cwd, expandido)
    if (!arquivos.includes(caminho)) arquivos.push(caminho)
    return ''
  })
  return { texto: limpo.replace(/\n{3,}/g, '\n\n').trim(), arquivos }
}

export function promptComArquivo(legenda, caminho, nomeOriginal) {
  const texto = String(legenda ?? '').trim() || PEDIDO_ARQUIVO_PADRAO
  const nome = nomeOriginal ? ` (${nomeOriginal})` : ''
  return `${texto}\n\n[arquivo anexado${nome} em ${caminho} — leia o arquivo para responder]`
}

// Two directories are kept on purpose and neither expires on its own: the
// bot's, so Claude can revisit a file from earlier in the same conversation
// (audio excepted — it is deleted right after transcription, see README), and
// the personal account's archive of what people send. Left alone both grow
// without bound. Anything older than maxAgeMs goes, regardless of kind; the
// caller decides how often this runs.
export function limparMediaAntiga({ dir, maxAgeMs, now = () => Date.now() }) {
  let arquivos
  try {
    arquivos = readdirSync(dir)
  } catch {
    return 0
  }

  let removidos = 0
  for (const nome of arquivos) {
    const caminho = join(dir, nome)
    let info
    try {
      info = statSync(caminho)
    } catch {
      continue
    }
    if (!info.isFile() || now() - info.mtimeMs <= maxAgeMs) continue
    try {
      unlinkSync(caminho)
      removidos += 1
    } catch {}
  }
  return removidos
}
