// Every message the bot sends on its own — not as a reply to you — is decided
// here. When a notification turns out to be noise, this is the file to change:
// return null for what should stay silent.

// The whole reply goes out; the notifier splits it to fit WhatsApp.
function corpo(texto) {
  return String(texto ?? '').trim()
}

function comoResponder(evento) {
  return evento.addressable ? `\n\nResponda com @${evento.title} <texto>.` : ''
}

// evento: { kind: 'done' | 'waiting' | 'status' | 'error', title, group,
//           parentTitle, addressable, doneStatus, summary, content, needs }
//
// Already filtered before reaching here: replies you got through a
// conversation, replies seen before a restart, and NEED lines about a pending
// item you were already told about, however they are worded.
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
    return `⏸️ [${evento.title}]${onde} parou e está esperando você:\n\n${corpo(evento.content)}${comoResponder(evento)}`
  }

  if (evento.kind === 'error') {
    return `⚠️ [${evento.title}]${onde} entrou em erro. Veja no agent-deck.`
  }

  return null
}
