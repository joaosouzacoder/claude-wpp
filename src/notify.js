// Alerts from other machines and scripts (CI, deploys, cron checks) reach the
// owner through here. A check that keeps failing tends to fire every run, so a
// `key` collapses repeats inside a window instead of flooding the chat.
//
// Only a delivered alert starts the window: a send that failed must not
// silence the retry that would have gotten through.

// The window map only needs the keys still inside their window; past this
// many live keys the oldest go first, so a caller minting a new key per call
// cannot grow it without bound.
const MAX_CHAVES = 1000

export function formatAlert({ text, source }) {
  return source ? `🔔 [${source}] ${text}` : `🔔 ${text}`
}

export function createNotifier({ send, dedupMs, now = () => Date.now(), maxKeys = MAX_CHAVES }) {
  const enviadoEm = new Map()

  function podar(agora) {
    for (const [chave, quando] of enviadoEm) {
      if (agora - quando >= dedupMs) enviadoEm.delete(chave)
    }
    // Map iterates in insertion order, and a re-sent key is re-inserted below,
    // so the first entries are the oldest.
    while (enviadoEm.size >= maxKeys) enviadoEm.delete(enviadoEm.keys().next().value)
  }

  async function notify({ text, source = null, key = null }) {
    const agora = now()
    podar(agora)
    if (key != null && enviadoEm.has(key)) return { sent: false, deduped: true }

    await send(formatAlert({ text, source }))
    if (key != null) {
      enviadoEm.delete(key)
      enviadoEm.set(key, agora)
    }
    return { sent: true, deduped: false }
  }

  return { notify }
}
