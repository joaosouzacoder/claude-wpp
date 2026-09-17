import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Claude Code keeps each conversation's transcript at
// ~/.claude/projects/<cwd with every non-alnum char turned into '->/<sessionId>.jsonl.
// Undocumented, but it is the same location claude-wpp already relies on for
// --resume to work at all (see README: "conversation history belongs to Claude
// Code, under ~/.claude/projects/").
function slugCwd(cwd) {
  return cwd.replace(/[^A-Za-z0-9]/g, '-')
}

export function transcriptPath(cwd, sessionId, { home = homedir() } = {}) {
  return join(home, '.claude', 'projects', slugCwd(cwd), `${sessionId}.jsonl`)
}

// The last assistant text block, with the timestamp Claude Code recorded for
// it. Returns null for anything that stops this from being a clean read:
// missing file, no assistant turn yet, or a turn that produced no text (only
// tool calls).
//
// This process hosts every concurrent session's poll loop plus the HTTP API
// and WhatsApp message intake on one event loop, and a transcript can grow
// large over a long-lived conversation — a blocking read here would stall
// all of that for however long it takes. Reading async offloads the actual
// I/O to libuv's threadpool instead.
export async function readLastReply({ cwd, sessionId, home } = {}) {
  if (!cwd || !sessionId) return null
  let raw
  try {
    raw = await readFile(transcriptPath(cwd, sessionId, { home }), 'utf8')
  } catch {
    return null
  }

  for (let i = raw.length; i > 0;) {
    const inicio = raw.lastIndexOf('\n', i - 2) + 1
    const linha = raw.slice(inicio, i).trim()
    i = inicio
    if (!linha) continue

    let entrada
    try {
      entrada = JSON.parse(linha)
    } catch {
      continue
    }
    if (entrada.type !== 'assistant') continue

    const texto = (entrada.message?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('')
    if (!texto) continue

    return { content: texto, timestamp: entrada.timestamp ?? null }
  }
  return null
}
