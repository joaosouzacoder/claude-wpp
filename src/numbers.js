export function normalizeNumber(entrada) {
  if (entrada == null) return ''
  return String(entrada).split('@')[0].split(':')[0].replace(/\D/g, '')
}

// Brazilian mobile: 55 + area code (2) + 9 + 8 digits. WhatsApp sometimes hands
// over the legacy format, without the ninth digit. Strip the 9 from both sides
// before comparing — keeping country and area code intact, so that two different
// area codes never match.
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

// In recent Baileys versions remoteJid can be an "@lid", which is not a phone
// number. In that case accept the message only if the real phone comes with it.
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
