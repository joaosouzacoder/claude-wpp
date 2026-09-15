import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Claude Code asks, once per folder, whether to trust it — with "No, exit"
// under the cursor. A `claude --bg` session sent into that dialog just sits
// there (status idle/blocked) instead of ever answering the prompt, unlike
// `-p`, which skips the dialog outright. For folders this daemon creates and
// controls itself, answering "yes" ahead of time keeps the behaviour the bot
// already had with agent-deck (see git history), which used to send Down+Enter
// into the dialog for the same reason.
//
// This writes into ~/.claude.json, Claude Code's own global state file — not a
// documented format, and shared with every other Claude Code session on this
// machine (including this one). The read-modify-write below re-reads right
// before writing and only ever sets one boolean on one project entry, to keep
// the window for clobbering a concurrent write from Claude Code itself as
// small as practical; it cannot make the write atomic against another writer.
export function ensureTrusted(cwd, { home = homedir() } = {}) {
  const path = join(home, '.claude.json')

  let config
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return
  }

  config.projects ??= {}
  const projeto = config.projects[cwd]
  if (projeto?.hasTrustDialogAccepted) return

  config.projects[cwd] = { ...projeto, hasTrustDialogAccepted: true }
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(config))
  renameSync(tmp, path)
}
