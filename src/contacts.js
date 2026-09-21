// Lets a caller say "Juliano Bailão" instead of a number: the personal
// account's log already knows every chat by name, and the caller — often a
// Claude session on another machine — has no way to look it up itself.

const MAX_CANDIDATOS = 5

// Case and accents are how names typed from memory differ from the ones
// stored: "Bailão" must find "Bailāo".
export function normalizarNome(texto) {
  return String(texto ?? '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

// A number is at least ten digits once formatting is gone; anything else is
// taken as a name.
export function pareceNumero(destino) {
  const texto = String(destino ?? '').trim()
  if (texto.includes('@')) return true
  return /^[\d\s()+-]+$/.test(texto) && texto.replace(/\D/g, '').length >= 10
}

// Pure: picks the chat a query means out of `chats` ({ jid, name, kind }).
// An exact (normalized) name wins outright; otherwise every word of the query
// has to appear in the name. Exactly one match or it is not resolved — a
// wrong guess would deliver to someone else.
export function escolherContato(chats, consulta) {
  const alvo = normalizarNome(consulta)
  if (!alvo) return { ok: false, motivo: 'vazio', candidatos: [] }

  const comNome = chats.filter((c) => c.name)
  const exatos = comNome.filter((c) => normalizarNome(c.name) === alvo)
  if (exatos.length === 1) return { ok: true, jid: exatos[0].jid, name: exatos[0].name }

  const palavras = alvo.split(' ')
  const parciais = exatos.length > 1
    ? exatos
    : comNome.filter((c) => palavras.every((p) => normalizarNome(c.name).includes(p)))

  if (parciais.length === 1) return { ok: true, jid: parciais[0].jid, name: parciais[0].name }
  if (!parciais.length) return { ok: false, motivo: 'nenhum', candidatos: [] }
  return { ok: false, motivo: 'ambiguo', candidatos: parciais.slice(0, MAX_CANDIDATOS).map((c) => c.name) }
}

export function createContactResolver(db) {
  const todos = db.prepare('SELECT jid, name, kind FROM chats WHERE name IS NOT NULL')
  return {
    resolve: (consulta) => escolherContato(todos.all(), consulta),
  }
}
