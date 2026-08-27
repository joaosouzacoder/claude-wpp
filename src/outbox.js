// The gate. Claude proposes here; only an explicit approval from the authorized
// number moves a row to `approved`, and only `approved` rows are ever sent.
// A draft and a scheduled job are the same row: scheduled_for NULL means
// "as soon as it is approved".

const TIPOS = new Set(['message', 'conditional'])

export function createOutbox({ db, now = () => Math.floor(Date.now() / 1000) }) {
  const stmt = {
    insert: db.prepare(`
      INSERT INTO outbox (kind, chat_jid, chat_name, body, quoted_wa_id, check_prompt,
                          scheduled_for, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `),
    get: db.prepare('SELECT * FROM outbox WHERE id = ?'),
    pending: db.prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY id"),
    scheduled: db.prepare(`
      SELECT * FROM outbox
      WHERE status = 'approved' AND scheduled_for IS NOT NULL
      ORDER BY scheduled_for
    `),
    due: db.prepare(`
      SELECT * FROM outbox
      WHERE status = 'approved' AND (scheduled_for IS NULL OR scheduled_for <= ?)
      ORDER BY scheduled_for, id
    `),
    lastSent: db.prepare(`
      SELECT * FROM outbox
      WHERE status = 'sent' AND sent_wa_id IS NOT NULL
      ORDER BY sent_at DESC, id DESC LIMIT 1
    `),
    decide: db.prepare('UPDATE outbox SET status = ?, decided_at = ? WHERE id = ? AND status = ?'),
    reopen: db.prepare("UPDATE outbox SET status = 'pending', decided_at = NULL, reason = ? WHERE id = ?"),
    sent: db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, sent_wa_id = ? WHERE id = ?"),
    encerrar: db.prepare('UPDATE outbox SET status = ?, reason = ? WHERE id = ?'),
    editar: db.prepare(`
      UPDATE outbox SET body = ?, status = 'pending', decided_at = NULL
      WHERE id = ? AND status IN ('pending', 'approved')
    `),
  }

  // A transition only fires from the state it is allowed to leave, so a repeated
  // /ok cannot approve something twice.
  function transicionar(id, de, para) {
    const { changes } = stmt.decide.run(para, now(), id, de)
    return changes > 0 ? stmt.get.get(id) : null
  }

  return {
    create({ kind = 'message', chatJid, chatName = null, body, quotedWaId = null, checkPrompt = null, scheduledFor = null } = {}) {
      if (!TIPOS.has(kind)) throw new Error(`tipo de tarefa desconhecido: ${kind}`)
      if (!String(chatJid ?? '').trim()) throw new Error('rascunho sem destino')
      if (!String(body ?? '').trim()) throw new Error('rascunho sem texto')
      if (kind === 'conditional' && !String(checkPrompt ?? '').trim()) {
        throw new Error('tarefa condicional exige a pergunta de verificação')
      }

      const { lastInsertRowid } = stmt.insert.run(
        kind, chatJid, chatName, String(body).trim(), quotedWaId, checkPrompt, scheduledFor, now(),
      )
      return stmt.get.get(lastInsertRowid)
    },

    get: (id) => stmt.get.get(id) ?? null,
    pending: () => stmt.pending.all(),
    scheduled: () => stmt.scheduled.all(),
    due: (ts) => stmt.due.all(ts),
    lastSent: () => stmt.lastSent.get() ?? null,

    approve: (id) => transicionar(id, 'pending', 'approved'),
    reject: (id) => transicionar(id, 'pending', 'rejected'),
    cancel: (id) => transicionar(id, 'approved', 'canceled'),

    // Changing the words of something already approved would let a text nobody
    // agreed to go out under an old approval. So an edit always lands back in
    // `pending`, and the owner approves the new wording or does not.
    edit(id, body) {
      if (!String(body ?? '').trim()) throw new Error('edição sem texto')
      const { changes } = stmt.editar.run(String(body).trim(), id)
      return changes > 0 ? stmt.get.get(id) : null
    },

    reopen(id, motivo) {
      stmt.reopen.run(motivo ?? null, id)
      return stmt.get.get(id) ?? null
    },

    markSent(id, waId) {
      stmt.sent.run(now(), waId ?? null, id)
      return stmt.get.get(id) ?? null
    },

    markFailed: (id, motivo) => (stmt.encerrar.run('failed', String(motivo ?? ''), id), stmt.get.get(id) ?? null),
    markSkipped: (id, motivo) => (stmt.encerrar.run('skipped', String(motivo ?? ''), id), stmt.get.get(id) ?? null),
    markDeleted: (id, motivo = null) => (stmt.encerrar.run('deleted', motivo, id), stmt.get.get(id) ?? null),
  }
}
