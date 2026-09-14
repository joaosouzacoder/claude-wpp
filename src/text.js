// A line too long for one message breaks at the last space that fits. Only a
// single word longer than the limit (a URL, a hash) is cut where it stands.
function quebrarLinha(linha, max) {
  const partes = []
  let resto = linha
  while (resto.length > max) {
    const espaco = resto.lastIndexOf(' ', max)
    const corte = espaco > 0 ? espaco : max
    partes.push(resto.slice(0, corte))
    resto = espaco > 0 ? resto.slice(corte + 1) : resto.slice(corte)
  }
  if (resto) partes.push(resto)
  return partes
}

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
      partes.push(...quebrarLinha(linha, max))
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
