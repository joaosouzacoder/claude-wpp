# claude-wpp — Claude Code over WhatsApp

**Date:** 2026-08-22
**Status:** approved, ready for the implementation plan

## Problem

Talk to Claude Code over WhatsApp, from a phone, keeping several independent
conversations and reusing the subscription already authenticated on this host —
without consuming the paid API.

## Decisions

| Decision | Choice | Reason |
|---|---|---|
| Language | Node 24 (ESM) | Already installed; Baileys is the best WhatsApp library and it is Node |
| WhatsApp library | `@whiskeysockets/baileys` | Plain WebSocket, no Chromium; ~80MB of RAM against ~500MB for `whatsapp-web.js`, which still breaks whenever the WhatsApp Web DOM changes |
| Claude driver | `claude -p` one-shot + `--resume <session_id>` | State lives in `~/.claude/projects/`, so the daemon is disposable; parallelism comes for free |
| Permissions | `--dangerously-skip-permissions`, unrestricted cwd | There is no way to approve a permission prompt over WhatsApp |
| Routing | Active session + `@name` prefix | A bare message goes to the active one; `@name` diverts without switching |
| Feedback | `"Trabalhando nisso."` after 8s, then only the final answer | Keeps the chat clean |
| HTTP API | `POST /send` + `GET /healthz` | Same contract the `send-whatsapp` skill already consumes |
| Persistence | JSON in `~/.local/state/claude-wpp/` | There is no relational data; a database would be dead weight |

### Checks made before deciding

The Claude driver was validated empirically on this host, not assumed:

1. `claude -p '…' --output-format json` returns `session_id` in the JSON.
2. `claude -p --resume <id> '…'` in a **fresh process** recovers the context of
   the previous conversation, and the `session_id` stays stable across resumes.
3. Two simultaneous `claude -p --dangerously-skip-permissions` runs execute real
   tools, in parallel, with zero `permission_denials`.

## Architecture

A single Node process. Small modules, one responsibility each.

```
~/claude-wpp/
├── src/index.js      bootstrap, wiring, clean shutdown
├── src/config.js     config.json + env, validated at boot
├── src/whatsapp.js   Baileys: connection, QR, reconnect, sendText, onMessage
├── src/router.js     command parser (/new, @name, bare text)
├── src/sessions.js   registry: create, list, switch, end, queue
├── src/claude.js     spawn of `claude -p`, JSON parse, timeout, slow notice
├── src/api.js        HTTP: POST /send, GET /healthz
└── src/store.js      persistence in ~/.local/state/claude-wpp/state.json
```

Inbound flow: `whatsapp` → `router` → `sessions` → `claude` → `whatsapp`.
The HTTP API goes straight into `whatsapp.sendText`, bypassing Claude.

### Interfaces between modules

- `whatsapp`: `connect()`, `sendText(jid, text)`, `on('message', ({from, text}))`,
  `state()` → `"open" | "connecting" | "closed"`.
- `sessions`: `create({cwd, name})`, `list()`, `get(name)`, `setActive(name)`,
  `end(name)`, `enqueue(name, text)`. No network I/O here.
- `claude`: `run({cwd, claudeSessionId, prompt, onSlow})` →
  `{ result, sessionId, isError }`. Knows nothing about WhatsApp.
- `store`: `load()`, `save(state)`. Serialization only.

`router` and `sessions` are pure functions over state; that is where most of the
tests live.

## Sessions

```js
{
  name: "api",                       // unique slug
  claudeSessionId: "a7b4ceaf-…",     // null until the first answer
  cwd: "/home/user/work/api",
  createdAt, lastActivityAt,
  busy: false,
  queue: []                          // messages that arrived during execution
}
```

Global state: `{ sessions: [...], activeSession: "api" }`, saved on every
mutation.

Only the `claudeSessionId` pointer is kept on disk — the real history belongs to
Claude Code, in `~/.claude/projects/`. Consequence: the daemon can crash, restart
or be upgraded without losing a single conversation.

A busy session queues the following messages and processes them in order — the
same session cannot be resumed in two processes at once. Distinct sessions do run
in parallel.

### Commands

| Command | Effect |
|---|---|
| `/new [dir] [name]` | Creates and activates. `dir` defaults to `~`, name auto (`s1`, `s2`…) |
| `/ls` | Lists: name, cwd, which one is active, idle time, whether it is busy |
| `/use <name>` | Switches the active session |
| `/end [name]` | Ends it (forgets the pointer); with no name, ends the active one |
| `/stop` | Kills the running process of the active session |
| `/help` | Lists the commands |
| `@name text` | Sends to `name` without switching the active one |
| *bare text* | Goes to the active session; creates one if there is none |

Every reply is prefixed with `[name]`. With parallel sessions the answers arrive
out of order, and the prefix is what identifies the origin.

`/end` forgets the pointer but deletes nothing under `~/.claude/projects/` — the
operation is cheap and reversible.

## Running Claude

```
spawn('claude', [
  '-p', text,
  '--output-format', 'json',
  '--dangerously-skip-permissions',
  ...(claudeSessionId ? ['--resume', claudeSessionId] : [])
], { cwd })
```

- With no `session_id` yet, omit `--resume` and record the id the JSON returns.
- **8 seconds** without finishing triggers `"Trabalhando nisso."`, once per
  message.
- Hard timeout of **15 minutes**: kills the process and replies with the error.
- An answer above ~3,500 characters is split into several messages, cutting at
  line breaks.
- `is_error: true` or invalid JSON on stdout becomes a readable error message,
  with stderr truncated.

## WhatsApp

Baileys with `useMultiFileAuthState` in `~/.local/state/claude-wpp/wa-auth`.

Pairing happens once: `npm run pair` in the foreground prints the QR code in the
terminal, scanned by the **+55 11 92222-2222** device. The credentials are saved
and the daemon starts on its own from then on.

Automatic reconnect when the connection drops. The only condition that stops the
service for good is `DisconnectReason.loggedOut` — then it has to be paired
again.

### Authorization

The service answers **exclusively** to the number **+55 11 91111-1111**.

Groups, own messages (`fromMe`) and any other sender are silently dropped: a
debug-level log, no reply. Not confirming the existence of the service to an
unauthorized sender is deliberate.

Number comparison normalizes the JID first — reduces it to digits only and
tolerates the ninth digit of Brazilian mobile numbers, as well as the `@lid`
format that recent Baileys versions deliver instead of `@s.whatsapp.net`.

## HTTP API

Plain `node:http`, no framework, listening on `127.0.0.1:8787`.

```
POST /send
  authorization: Bearer <token>
  { "to": "5511911111111", "text": "…" }
  → 200 { "ok": true }

GET /healthz
  → 200 { "ok": true, "wa": "open", "sessions": 2 }
```

The token is the same one already used by the `send-whatsapp` skill, which keeps
working unchanged. `/healthz` requires no token; `/send` does.

## systemd

`~/.config/systemd/user/claude-wpp.service`, with `Restart=always` and
`RestartSec=5`.

Absolute paths, resolved at install time — the systemd environment does not have
the asdf shims:

- node: `/home/user/.asdf/installs/nodejs/24.15.0/bin/node`
- claude: `/home/user/.local/bin/claude` (a stable symlink; the version
  underneath changes on every update). The service `PATH` includes
  `~/.local/bin`.

Requires **`sudo loginctl enable-linger $USER`**. Without linger the service dies
at logout and does not start at boot. It is the only sudo command in the project.

## Tests

TDD on `sessions`, `router` and `store` with `node:test`: command parser, session
lifecycle, message queue, persistence and state recovery.

`claude.js` is tested against a fake `claude` executable, injected into the test
`PATH`, which echoes a controlled JSON. It checks the assembled flags, the
presence and absence of `--resume`, the timeout behaviour and the firing of
`"Trabalhando nisso."`.

`whatsapp.js` and `api.js` are left to manual smoke testing. Mocking Baileys
costs more than the test would deliver.

## Out of scope

Multiple authorized numbers, multi-user, per-tool progress streaming, web
interface, database, Docker.

## Accepted risk

Permission bypass with an unrestricted directory means any message from the
authorized number runs real commands on this machine, as the service user and
without confirmation. Whoever controls that WhatsApp account has a shell here.

The decision was made knowingly by the host owner. The mitigations that exist: a
single authorized number, the API bound to `127.0.0.1`, and no reply at all to an
unknown sender.
