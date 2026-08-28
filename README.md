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
| `/use <name>` | switches the active session |
| `/end [name]` | ends the session |
| `/stop` | interrupts whatever the active session is doing |
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

## Audio and images

A voice note is transcribed by the OpenAI transcription API and then follows the
exact same path as typed text — so `/ls` and `@session do this` work dictated.
The audio file is deleted as soon as the transcript comes back.

An image is written to `~/.local/state/claude-wpp/media/` and its path goes into
the prompt; Claude reads the file with its own `Read` tool. The caption is the
prompt, and `@session` in the caption routes it. Without a caption the bot asks
Claude to analyse the image. Images are kept on disk so Claude can revisit them
later in the session — prune that directory if it grows.

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

When something takes longer than 8 seconds, the bot replies `Trabalhando nisso.`
once and sends the result afterwards.

There is no time ceiling: a job that needs an hour gets an hour. The cost is
that a stuck run holds its session until you send `/stop`, so nothing queued
behind it moves. Set `timeoutMs` in milliseconds if you would rather have a cap. Every reply is prefixed with
`[session-name]`, because with parallel sessions they arrive out of order.

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
messages as the bot and starts a Claude run on this machine. A private overlay
address — Tailscale, WireGuard — reaches your other devices without putting any
of that on a public interface.

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

| Key | Default | What it does |
|---|---|---|
| `apiHost` | `127.0.0.1` | address the API binds to |
| `apiPort` | `8787` | port the API binds to |

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
