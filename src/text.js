export function chunkText(texto, max) {
  const str = String(texto ?? '')
  if (str.length <= max) return [str]

  const partes = []
  let atual = ''

  for (const linha of str.split('\n')) {
    if (linha.length > max) {
      if (atual) {
        partes.push(atual)
        atual = ''
      }
      for (let i = 0; i < linha.length; i += max) partes.push(linha.slice(i, i + max))
      continue
    }
    const candidato = atual ? `${atual}\n${linha}` : linha
    if (candidato.length > max) {
      partes.push(atual)
      atual = linha
    } else {
      atual = candidato
    }
  }

  if (atual) partes.push(atual)
  return partes.length ? partes : ['']
}
