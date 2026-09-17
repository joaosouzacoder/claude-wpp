# claude-wpp

[![CI](https://github.com/joaosouzacoder/claude-wpp/actions/workflows/ci.yml/badge.svg)](https://github.com/joaosouzacoder/claude-wpp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)](package.json)

Claude Code over WhatsApp, with several parallel sessions, using the
subscription already authenticated on this host. It does not consume the paid
API.

> **Read [SECURITY.md](SECURITY.md) before deploying.** The service runs Claude
> with permission checks disabled: whoever controls the authorized WhatsApp
> account has a shell on your machine.

## Install

```bash
cd ~/claude-wpp
npm install
cp config.example.json config.json    # set your apiToken and numbers
./install.sh
sudo loginctl enable-linger "$USER"   # once
npm run pair                          # scan the QR code with the bot number
systemctl --user start claude-wpp
```

## Usage on WhatsApp

| Command | Effect |
|---|---|
| `/new [dir] [name]` | creates a session and makes it active |
| `/ls` | lists the sessions |
| `/manuais` | lists claude sessions on this host the bot does not control |
| `/importar <n> [name]` | adopts session `n` from `/manuais` so `@name` can reach it |
| `/use <name>` | switches the active session |
| `/end [name]` | ends the session (says how many queued messages it dropped, if any) |
| `/stop` | interrupts whatever the active session is doing |
| `/retomar [name]` | redoes the request a restart killed mid-run |
| `/descartar [name]` | forgets the request a restart killed mid-run |
| `/help` | lists the commands |
| `/wpp <request>` | reads your own WhatsApp and prepares a message (see below) |
| `/ok <n>` | approves draft `n` — the only way anything gets sent |
| `/edit <n> <text>` | rewrites draft `n`; it needs `/ok` again |
| `/no <n>` | discards a draft or cancels a schedule |
| `/schedulers` | what is waiting for your approval and what is scheduled |
| `/undo` | deletes the last message sent on your behalf |
| `@name text` | sends to another session without switching the active one |
| bare text | goes to the active session |
| voice note or audio | transcribed, then treated as if you had typed it |
| image | forwarded to Claude; the caption is the prompt |

Every message dispatched from here carries a system-prompt note (via
`--append-system-prompt`) telling Claude the reply is read on a phone inside
WhatsApp, not a terminal — so it favors short paragraphs and plain text over
big tables or deeply nested markdown. Claude Code only renders a session's
system prompt from its first message onward, so a session `/importar` picked
up already had this decided before the bot ever touched it.

## Audio and images

A voice note is transcribed by the OpenAI transcription API and then follows the
exact same path as typed text — so `/ls` and `@session do this` work dictated.
The audio file is deleted as soon as the transcript comes back.

An image is written to `~/.local/state/claude-wpp/media/` and its path goes into
the prompt; Claude reads the file with its own `Read` tool. The caption is the
prompt, and `@session` in the caption routes it. Without a caption the bot asks
Claude to analyse the image. Images are kept on disk so Claude can revisit them
later in the session — every boot removes anything older than `mediaMaxAgeMs`
on its own, so growth is bounded automatically instead of needing a manual prune.

Audio needs an OpenAI key, in `openaiApiKey` or in `OPENAI_API_KEY`. **This is
the one part of the project that talks to a paid third-party API**, and it is
optional: without a key, audio replies with the reason and everything else keeps
working. Video, documents and stickers are still ignored — only the caption of a
video is read, as before.

| Key | Default | What it does |
|---|---|---|
| `openaiApiKey` | `null` | key for the transcription API; audio is off without it |
| `transcribeModel` | `gpt-4o-transcribe` | transcription model |
| `transcribeTimeoutMs` | `120000` | gives up on a transcription after this |
| `mediaDir` | `<stateDir>/media` | where received media is written |
| `mediaMaxAgeMs` | `2592000000` (30 days) | media older than this is deleted on boot |
| `heartbeatMs` | `300000` | how often a running job repeats that it is alive |
| `blockedTimeoutMs` | `1200000` (20 min) | how long a `blocked` session is given before claude-wpp cancels it on its own |

When something takes longer than 8 seconds, the bot replies `Trabalhando nisso.`
and then repeats `Ainda trabalhando nisso (12min).` every `heartbeatMs` until
the result arrives, so a long job and a stuck one stop looking alike.

There is no time ceiling on an ordinary long job: one that needs an hour gets
an hour. The cost is that a stuck run holds its session until you send
`/stop`, so nothing queued behind it moves. Set `timeoutMs` in milliseconds if
you would rather have a cap. Every reply is prefixed with
`[session-name]`, because with parallel sessions they arrive out of order.

### A restart no longer eats your request

The prompt being run and the ones queued behind it are written to the state
file, not just held in memory. If the daemon dies mid-run — a deploy, a crash,
a reboot — the next boot tells you which request never finished and offers
`/retomar` to redo it or `/descartar` to forget it. Nothing is re-run on its
own, because the dead run may already have had side effects.

An ordinary message sent to that session before you answer is queued, not run
— starting a fresh turn would overwrite the record of the one still waiting
on you. It runs on its own right after `/retomar` (or stays queued for next
time, if you `/descartar` instead).

Example:

```
/new ~/work/api api
> Sessão [api] criada em /home/user/work/api

list the failing tests
> Trabalhando nisso.
> [api] 3 tests failing in auth_spec.rb...

@infra check the disk on srv1
> [infra] /dev/sda1 at 81%
```

## Sessions are native Claude Code background agents

Each session is a `claude --bg` background agent — the same kind `claude
agents` lists and `claude attach <id>` opens outside the bot. `/new` only
registers the name and directory; the first message to it starts the actual
background agent, and every later message continues the same conversation
with `--resume`. The reply is read straight from the conversation's own
transcript (`~/.claude/projects/…/<session-id>.jsonl`, the same file
`--resume` already depends on to work at all) — nothing is scraped from a
terminal.

The background agent only exists for the duration of one turn: as soon as its
reply is read, claude-wpp stops and removes it (`claude stop` + `claude rm`),
so it never lingers idle in `claude agents` between messages. The next message
starts a fresh one with `--resume`, which rebuilds everything from the
transcript regardless of whether the previous one is still around — resuming
a session whose process has already fully exited (rather than one merely left
idle) forks into a new conversation id, and claude-wpp follows that id from
then on, sweeping away the one it forked from so it doesn't linger either.

| | |
|---|---|
| `/ls` | every session this bot knows about, busy or idle |
| `@name text` | sends to that session; a busy one gets it after its current turn |
| `/new [dir] [name]` | registers a session; nothing runs until the first message |
| `/end [name]` | forgets the session here; interrupts it first if a turn is in flight |
| `/stop` | runs `claude stop <id>` on the turn in flight, not just the wait |

Because the background agent is not a child process of this daemon, a
`claude-wpp` restart does not kill work in progress: if the daemon comes back
up before the turn ends, `/retomar` catches it up; if the turn had already
finished while nobody was listening, the next boot delivers that answer
directly instead of asking you to redo it.

A folder this daemon has never used goes through Claude Code's one-time "do
you trust this folder?" dialog — which a background agent sits on forever
instead of skipping, unlike the plain `-p` calls the `/wpp` check still uses.
For a folder `/new` creates itself, claude-wpp marks it trusted ahead of time
by writing into `~/.claude.json`, Claude Code's own global state file, shared
by every Claude Code session on this machine. **Read
[SECURITY.md](SECURITY.md) for what that means.**

### Picking up a session you started by hand

`/ls` only shows sessions this bot created. A session you started yourself —
`claude` in a terminal, or `claude --bg` from the CLI — is invisible to it
until you adopt it:

```
/manuais
1. caws — /home/user/projects/api  (idle · interactive)
2. migration-check — /home/user/scratch  (busy · background)

/importar 1
> Sessão [caws] importada de /home/user/projects/api. Ativa agora: [caws].

@caws como ficou o build?
> [caws] ...
```

`/manuais` lists every claude session on the host — via `claude agents
--all`, so it includes ones this bot has never touched, and also this bot's
own machine-level neighbors (other tools' background agents) — except the
ones already tracked here. `/importar <n> [name]` reuses that numbered list:
it registers session `n`'s directory and conversation under `name` (or the
session's own name, sanitized, or the usual `s1`, `s2`… if neither is usable)
the same way `/new` would. Nothing about the original session changes; if it
is still open in a terminal somewhere, messaging it here continues the same
conversation from another angle, the same way `claude --bg --resume` always
does with a session that is idle elsewhere.

**A session that is genuinely busy elsewhere is refused, not queued or
copied.** `claude --resume` on a session already running does start a second
copy as documented, but if that turn had a background shell command still
pending, the copy has been observed getting stuck forever instead of ever
answering — a `claude` bug, not something this project works around. Every
message checks the target's live status first and answers with an error
instead of risking that: wait for it to go idle (`/manuais` shows the current
status) and try again, or `claude attach <id>` on the host to see what it is
doing.

**A session whose process has already exited for good (`/manuais` marks it
"done — processo já saiu, resumir pode travar") carries a real, residual
risk beyond that check.** Resuming one still works most of the time, but has
been seen getting stuck in `blocked` in more than one way that this project
cannot detect ahead of time or fix at the root — a `claude` behavior around
reviving a fully dead session, not a bug here. `state: blocked` has even been
seen sticking around for a turn that actually finished normally (a real
answer already sitting in the transcript, Stop hooks already run) — the field
itself just never flipped back. Every time it shows up, claude-wpp checks for
a fresh reply first and delivers it immediately if there is one; only a
genuine stall (no reply, still blocked next poll) gets the "parou esperando"
notice on WhatsApp (`claude attach <id>` shows what it is waiting on), sent
once and then left quiet instead of repeating "ainda trabalhando". `/stop`
clears a real stall right away if you catch it; left alone, `blockedTimeoutMs`
(20 minutes by default) cancels it on its own. Expect the occasional stuck
turn from an old, already-finished session more than from a session that only
went idle.

You can watch or nudge an in-flight run yourself, the same way you would any
other background agent on this host: `claude agents` lists it, `claude attach
<id>` opens it in a terminal, `claude logs <id>` prints its raw output.

## Your own WhatsApp

The bot has its own number. Optionally, a **second account — yours** — can be
paired so Claude can read your real conversations and write messages as you.
This is off unless you turn it on.

```bash
# config.json
"personalNumber": "5511911111111"

npm run pair:me                       # scan the QR with your own phone
systemctl --user restart claude-wpp
```

**Read [SECURITY.md](SECURITY.md) first.** Two things change materially: every
message that account sends or receives is recorded to a local SQLite database
with no expiry, including in groups whose members never agreed to it; and
automating a personal account breaks the WhatsApp Terms of Service, so the
account can be banned.

The account only ever **records**. Nothing arriving on your personal WhatsApp
triggers Claude — there is no code path from an incoming message to an action.
It acts when you ask it to, from the bot's chat.

### Asking for something

```
/wpp look at the leaders group and answer John Doe — the migration slips a week

> [wpp] John asked on Tuesday whether it was still on for the 29th.
> [wpp] draft #3 → Team Leads (replying to John)
>       "Fala John, a migração vai ficar pra semana que vem..."
>       /ok 3 approves · /no 3 discards

/ok 3
> Aprovado, mandando #3.
> [wpp] mandei para Team Leads: "..." — /undo desfaz.
```

Claude reads the log with SQL and proposes. **It cannot send.** A draft sits as
`pending` until you reply `/ok`, and `/undo` deletes the last message sent as
long as WhatsApp still allows deleting it for everyone.

If the wording is not yours, `/edit 3 the text you actually want` replaces it.
An edit always returns the draft to `pending`, including one you had already
approved — otherwise words nobody agreed to could go out under an old approval.

### Scheduling

```
/wpp remind Jane Doe tomorrow at 9 to bring the macbook,
    but check first whether they already answered

> [wpp] draft #4 → Jane — sai em 28/08/2026, 09:00
>       antes de mandar, verifica: já confirmou que traz o macbook?
>       "Bom dia! Lembra de trazer o macbook hoje."
>       /ok 4 aprova · /no 4 descarta
```

A **conditional** job is checked again the moment before it fires: Claude reads
that conversation since you scheduled it and answers send-or-skip, with a
reason. It votes on *whether* to send — never on *what*, because you approved
those exact words.

If the machine was down past the deadline, the job goes back to pending and asks
instead of sending a "good morning" in the afternoon (`scheduleToleranceSec`,
one hour by default).

Firing time is stored as an absolute instant, so it is right whatever the host's
clock is set to. What `timezone` controls is the hour you are *shown* when
approving — on a UTC host, without it, a 09:00 reminder is confirmed back to you
as "12:00" and you would reject a draft that was correct.

Sending is real and cannot be undone by retrying, so a job is marked `sending`
the instant before the actual WhatsApp call — not after, and not folded into
`approved`. That closes the one race that mattered: `/no` or `/edit` arriving
while a conditional job's check is still running (a real Claude call, can take
seconds) loses to nothing, because the job is still plainly `approved` for
that whole wait and your command lands normally; once the send itself starts,
nothing can relabel that row out from under it. A restart that catches a job
mid-`sending` cannot know whether the message actually went out, so it never
guesses either way: the job goes back to pending with a note asking you to
check the conversation before approving it again.

### The log

`~/.local/state/claude-wpp/wpp.db`, two tables, queryable with plain SQL:

```sql
chats(jid, name, kind, updated_at)
messages(id, wa_id, chat_jid, sender_jid, sender_name,
         from_me, ts, kind, body, quoted_wa_id)
```

Media is never downloaded — an audio message is stored as `[áudio 0:14]`. Text
search runs through an FTS5 index.

WhatsApp replays a slice of recent history exactly once, to whichever process
links the device — so `npm run pair:me` is what records it, and it waits for the
dump to go quiet before exiting. Do not interrupt it. A daemon reconnecting
later is handed nothing, and the only way to get that history back is to unlink
the device on your phone and pair again.

`agent/CLAUDE.md` is what teaches the `/wpp` session how to use all this; edit it
to change how Claude writes as you.

| Key | Default | What it does |
|---|---|---|
| `personalNumber` | `null` | your number; the whole feature is off while this is unset |
| `timezone` | `America/Sao_Paulo` | the zone every time is *shown* in — set it, the host is often UTC |
| `schedulerIntervalMs` | `30000` | how often the queue is checked |
| `scheduleToleranceSec` | `3600` | past this delay, a late job asks instead of firing |

## The API

The service binds to `apiHost:apiPort`, `127.0.0.1:8787` by default. Move it off
loopback only knowing what that exposes: whoever holds the token sends WhatsApp
messages as the bot and starts a Claude run on this machine, which runs with
permission checks disabled. A private overlay address — Tailscale, WireGuard —
reaches your other devices without putting any of that on a public interface.

There is no TLS here. On a public address the bearer token crosses the network
in cleartext on every call, so anyone on the path collects it and keeps it. If
the API has to be reachable from the internet, put it behind a reverse proxy
that terminates HTTPS and leave this bound to loopback.

```bash
curl -X POST $HOST/send \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"to":"5511911111111","text":"hi"}'

curl -X POST $HOST/wpp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"request":"answer John in the leaders group - the migration slips a week"}'

curl $HOST/healthz
```

`POST /send` writes as the **bot**, immediately. `POST /wpp` is the `/wpp`
command reached from anywhere: it rebuilds the request and hands it to the same
handler, so it runs the same session under the same `agent/CLAUDE.md` and cannot
drift from what typing `/wpp` does. It answers `202` the moment the request is
queued — the run takes as long as it takes and reports on WhatsApp, which is
where the draft waits for your `/ok` regardless.

`POST /outbox` proposes a draft directly. It never sends either: the draft waits
for `/ok` on WhatsApp. It is how `agent/propose.mjs` works, and the only write
path Claude is given.

The token does not have to sit in `config.json`. `WPP_TOKEN` or
`CLAUDE_WPP_API_TOKEN` in the environment takes precedence over the file, so it
can live wherever the machine already keeps its secrets — the unit reads
`~/.tokens` if that file exists. Whichever way it arrives, it is required: the
daemon refuses to start without one rather than serving an open API.

| Key | Default | What it does |
|---|---|---|
| `apiHost` | `127.0.0.1` | address the API binds to |
| `apiPort` | `8787` | port the API binds to |
| `apiToken` | — | required; `WPP_TOKEN` in the environment overrides it; refuses the exact placeholder from `config.example.json` |

## Operation

```bash
systemctl --user status claude-wpp
journalctl --user -u claude-wpp -f
systemctl --user restart claude-wpp
```

State lives in `~/.local/state/claude-wpp/`. The conversation history belongs to
Claude Code, under `~/.claude/projects/` — restarting the service loses no
session.

## Tests

```bash
npm test
```

## Warning

The service runs Claude with `--dangerously-skip-permissions` and an unrestricted
working directory. Whoever has access to the authorized WhatsApp number runs
commands on this machine as your user. Only the number configured in
`authorizedNumber` is served; any other sender is silently ignored.

The full threat model — what this protects against and what it does not — is in
[SECURITY.md](SECURITY.md).

## Contributing

Bug reports and pull requests are welcome. Start with
[CONTRIBUTING.md](CONTRIBUTING.md); the scope of the project is deliberately
narrow, and the *Out of scope* section of the
[design spec](docs/superpowers/specs/2026-08-22-claude-wpp-design.md) says what
was already considered and rejected.

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

Never commit real phone numbers, e-mail addresses or absolute home paths — CI
fails the build if one shows up. Use the placeholders documented in
CONTRIBUTING.md.

## License

[MIT](LICENSE) © João Souza
