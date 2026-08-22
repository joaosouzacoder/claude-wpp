export function normalizeNumber(entrada) {
  if (entrada == null) return ''
  return String(entrada).split('@')[0].split(':')[0].replace(/\D/g, '')
}

// Celular brasileiro: 55 + DDD (2) + 9 + 8 dígitos. O WhatsApp às vezes entrega
// o formato antigo, sem o nono dígito. Removemos o 9 dos dois lados antes de
// comparar — mantendo país e DDD intactos, para não casar DDDs diferentes.
function semNonoDigito(digitos) {
  return /^55\d{2}9\d{8}$/.test(digitos) ? digitos.slice(0, 4) + digitos.slice(5) : digitos
}

export function sameNumber(a, b) {
  const x = normalizeNumber(a)
  const y = normalizeNumber(b)
  if (!x || !y) return false
  if (x === y) return true
  return semNonoDigito(x) === semNonoDigito(y)
}

// Em versões recentes do Baileys o remoteJid pode ser um "@lid", que não é
// telefone. Nesse caso só aceitamos a mensagem se o telefone real vier junto.
export function senderNumber(key = {}) {
  const candidatos = [key.senderPn, key.remoteJidAlt, key.participantPn, key.participant, key.remoteJid]
  for (const jid of candidatos) {
    if (typeof jid === 'string' && !jid.includes('@lid')) {
      const digitos = normalizeNumber(jid)
      if (digitos) return digitos
    }
  }
  return null
}
