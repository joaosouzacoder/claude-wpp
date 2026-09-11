// Every message the bot sends on its own — not as a reply to you — is decided
// here. When a notification turns out to be noise, this is the file to change:
// return null for what should stay silent.

const PREVIA_MAX = 700

function previa(texto) {
  const limpo = String(texto ?? '').trim()
  return limpo.length > PREVIA_MAX ? `${limpo.slice(0, PREVIA_MAX)}…` : limpo
}

function comoResponder(evento) {
  return evento.addressable ? `\n\nResponda com @${evento.title} <texto>.` : ''
}

// evento: { kind: 'done' | 'waiting' | 'status' | 'error', title, group,
//           parentTitle, addressable, doneStatus, summary, content, needs }
//
// Already filtered before reaching here: replies you got through a
// conversation, replies seen before a restart, and a conductor repeating the
// same NEED lines it reported last time.
export function formatNotification(evento) {
  const onde = evento.parentTitle ? ` (filho de ${evento.parentTitle})` : ''

  // A conductor's heartbeat: worth a message only when it names something
  // that needs you.
  if (evento.kind === 'status') {
    if (!evento.needs.length) return null
    const itens = evento.needs.map((n) => `• ${n}`).join('\n')
    return `🔔 [${evento.title}] precisa de você:\n${itens}${comoResponder(evento)}`
  }

  if (evento.kind === 'done') {
    const icone = evento.doneStatus === 'ok' ? '✅' : '❌'
    const verbo = evento.doneStatus === 'ok' ? 'terminou' : 'falhou'
    return `${icone} [${evento.title}]${onde} ${verbo}: ${evento.summary}`
  }

  if (evento.kind === 'waiting') {
    return `⏸️ [${evento.title}]${onde} parou e está esperando você:\n\n${previa(evento.content)}${comoResponder(evento)}`
  }

  if (evento.kind === 'error') {
    return `⚠️ [${evento.title}]${onde} entrou em erro. Veja no agent-deck.`
  }

  return null
}
