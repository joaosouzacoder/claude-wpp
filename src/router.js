const NOME = /^[a-z0-9_-]{1,24}$/i

export function parse(entrada) {
  const texto = String(entrada ?? '').trim()

  if (texto.startsWith('/')) {
    const [cru, ...args] = texto.slice(1).split(/\s+/).filter(Boolean)
    if (!cru) return { type: 'error', message: 'Comando vazio. Manda /help.' }
    return { type: 'command', name: cru.toLowerCase(), args }
  }

  if (texto.startsWith('@')) {
    const casou = texto.match(/^@([a-z0-9_-]{1,24})\s+([\s\S]+)$/i)
    if (casou) return { type: 'message', target: casou[1], text: casou[2].trim() }
    const sozinho = texto.slice(1)
    if (NOME.test(sozinho)) {
      return { type: 'error', message: 'Faltou o texto. Uso: @nome sua mensagem' }
    }
  }

  return { type: 'message', target: null, text: texto }
}
