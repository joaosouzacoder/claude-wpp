import { mkdirSync, writeFileSync } from 'node:fs'
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
