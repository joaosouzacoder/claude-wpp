import { mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

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
}

const PADRAO_POR_TIPO = { image: 'jpg', audio: 'ogg' }

const PEDIDO_PADRAO = 'Analise a imagem anexada.'

// WhatsApp sends the mimetype with parameters ("audio/ogg; codecs=opus").
function extensao(mimetype, kind) {
  const base = String(mimetype ?? '').split(';')[0].trim().toLowerCase()
  return EXTENSOES[base] ?? PADRAO_POR_TIPO[kind] ?? 'bin'
}

export function saveMedia({ dir, buffer, mimetype, kind }) {
  mkdirSync(dir, { recursive: true })
  const caminho = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${extensao(mimetype, kind)}`)
  writeFileSync(caminho, buffer)
  return caminho
}

export function promptComImagem(legenda, caminho) {
  const texto = String(legenda ?? '').trim() || PEDIDO_PADRAO
  return `${texto}\n\n[imagem anexada em ${caminho} — leia o arquivo para respondê-la]`
}

// Images are kept on disk on purpose — so Claude can revisit one from earlier
// in the same conversation — unlike audio, which is deleted right after
// transcription (see README). That intentional retention has no expiry of
// its own, so left alone it grows without bound. This is the automatic half
// of "prune that directory if it grows": anything older than maxAgeMs goes,
// on every boot, regardless of kind.
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
