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
| `/cd <dir>` | moves the active session to another folder (relative to its current one); the conversation starts over, since Claude Code files history per folder |
| `/end [name]` | ends the session (says how many queued messages it dropped, if any) |
| `/stop` | interrupts whatever the active session is doing |
| `/retomar [name]` | redoes the request a restart killed mid-run |
| `/descartar [name]` | forgets the request a restart killed mid-run |
| `/help` | lists the commands |
| `/wpp <request>` | reads your own WhatsApp and prepares a message (see below) |
| `/ok <n>` | approves draft `n` and sends it **as you**, from your own account — the only way anything gets sent |
| `/bot <n>` | approves draft `n` and sends its **formal** version from the **bot's** number instead |
| `/edit <n> <text>` | rewrites draft `n`; it needs `/ok` again |
| `/no <n>` | discards a draft or cancels a schedule |
| `/schedulers` | what is waiting for your approval and what is scheduled |
| `/undo` | deletes the last message sent on your behalf |
| `@name text` | sends to another session without switching the active one |
| bare text | read as a command when it means one (see below), otherwise goes to the active session |
| voice note or audio | transcribed, then treated as if you had typed it |
| image | forwarded to Claude; the caption is the prompt |

Every message dispatched from here carries a system-prompt note (via
`--append-system-prompt`) telling Claude the reply is read on a phone inside
WhatsApp, not a terminal — so it favors short paragraphs and plain text over
big tables or deeply nested markdown. Claude Code only renders a session's
system prompt from its first message onward, so a session `/importar` picked
up already had this decided before the bot ever touched it.

### Talking to it instead of commanding it

Everything you send that is not a `/command` and not `@session` goes to one
long conversation with the assistant — the same session `/wpp` uses, which
remembers what you said before. It decides what you meant and acts:

> **você:** o juliano respondeu?
> **assistente:** Ainda não. A última foi minha, 14h20, cobrando o deploy.
> **você:** cutuca de leve
> **assistente:** Mandei: "Juliano, tudo certo com o deploy?"

It answers as itself, with no `[session]` label in front — a project session
keeps its name, because several of them answer out of order. It can write and
send a message (as you or as the bot), take one back, read your log, schedule,
and hand work that is not about messages to a project session, which then
answers you directly, labelled. Commands still work, as shortcuts.

Without the personal account paired there is no assistant, and plain text
keeps going to the active session, as before.

Your words reach it verbatim. When a plain-words message is read as
`/wpp` (below), the request that gets dispatched is **your** text, not the
classifier's summary of it: a paraphrase drops what mattered — who signs it,
who did the thing — and sends a message you did not ask for.

The request also carries the list of people the bot itself has already written
to, and when, so the agent reads that conversation before writing the formal
wording instead of greeting someone it spoke to an hour ago. And the session is
recreated whenever `agent/CLAUDE.md` changes, since a running session keeps the
instructions it started with.

**It sends without asking you first.** Told to send something, it writes it and
sends it, then shows you exactly what went out — that is what "no commands"
costs. `undo` takes back the last one. It proposes instead of sending when it
is not sure: an ambiguous recipient, or content it could not confirm.

### Tasks: something that repeats, or happens later

"Todo dia às 9 confere o chamado e me conta" is a task, not a cron line. The
assistant schedules it with `act.mjs tarefa --daily 09:00 --prompt "…"`; at
that hour the sentence is handed back to its own session, with all its tools,
and it answers in the chat. `act.mjs tarefas` lists what is scheduled, which
makes it the one true answer to "o que está agendado?", and the assistant
closes a task with `tarefa-fim` once the thing it was watching has happened.

Hours are wall time in `timezone`, computed per run, so a daily task keeps its
hour across a DST change. A one-off task disappears after it runs. The
assistant is told never to write to the host's crontab: the one time it did,
the shell script it wrote misread an answer, deleted its own cron line and
messaged him something this session then contradicted.

### Commands in plain words (without the assistant)

With the personal account paired, the assistant above reads everything and
this layer is off: two things reading the same sentence would race to act on
it. What follows is what happens **without** a personal account, when there is
no assistant to talk to.

Typed or dictated, a short message that means a command runs as that command:
"manda o 31 pelo bot" is `/bot 31`, "descarta esse" quoting a draft is `/no`
on that draft, "avisa a Ana que a reunião mudou" is `/wpp avisa a Ana…`,
"o que tem pendente?" is `/schedulers`. The bot answers `🗣️ Entendi: /bot 31`
before running it, so you always see what it understood.

A one-shot `claude -p` on your own subscription (`intentModel`, `haiku` by
default — no paid API tokens) does the reading, which adds about five seconds
before a message that is not a command reaches the session. It is given the
command list, the pending drafts and the message you quoted. What it answers is only accepted if it is a known command, and
`/ok`, `/bot`, `/no` and `/edit` only run on a draft you pointed at — by
number, by quoting it, or by it being the only one pending — so "joga fora o
rascunho" with two pending does nothing. Anything else (a coding request, a
question, a doubt, text over 400 characters, a failure or timeout)
goes to the active session exactly as before. Images and documents always go
to the session.

## Audio, images and files

A voice note is transcribed by the OpenAI transcription API and then follows the
exact same path as typed text — so `/ls` and `@session do this` work dictated.
The audio file is deleted as soon as the transcript comes back.

An image is written to `~/.local/state/claude-wpp/media/` and its path goes into
the prompt; Claude reads the file with its own `Read` tool. The caption is the
prompt, and `@session` in the caption routes it. Without a caption the bot asks
Claude to analyse the image. Images are kept on disk so Claude can revisit them
later in the session — every boot removes anything older than `mediaMaxAgeMs`
on its own, so growth is bounded automatically instead of needing a manual prune.

A document — PDF, spreadsheet, CSV, log, anything sent as a file — works the
same way: saved under that directory with its original name (so its extension
still tells Claude how to open it), path in the prompt, caption as the request.
Without a caption the bot asks Claude to analyse it. Documents over 50 MB are
refused before they are downloaded, since the download is held in memory.

Files also go the other way. Claude is told that writing
`[[arquivo: /path/to/file]]` on a line of its own hands you that file: the
line is removed from the reply and the file arrives as an attachment right
after the text. A relative path is resolved from the session's folder. A path
that does not exist, or a file over 64 MB, becomes a short note instead of
silently vanishing. It only ever goes to `authorizedNumber` — the same person
who already has a shell here through Claude. Like the rest of that
instruction, a session learns it from its first message, so one started
before this feature needs `/end` + `/new` (or `/cd`) to pick it up.

Audio needs an OpenAI key, in `openaiApiKey` or in `OPENAI_API_KEY`. **This is
the one part of the project that talks to a paid third-party API**, and it is
optional: without a key, audio replies with the reason and everything else keeps
working. Video and stickers are still ignored — only the caption of a video is
read, as before.

| Key | Default | What it does |
|---|---|---|
| `openaiApiKey` | `null` | key for the transcription API; audio is off without it |
| `transcribeModel` | `gpt-4o-transcribe` | transcription model |
| `transcribeTimeoutMs` | `120000` | gives up on a transcription after this |
| `mediaDir` | `<stateDir>/media` | where received media is written |
| `mediaMaxAgeMs` | `2592000000` (30 days) | media older than this is deleted on boot |
| `heartbeatMs` | `300000` | how often a running job repeats that it is alive |
| `blockedTimeoutMs` | `1200000` (20 min) | how long a `blocked` session is given before claude-wpp cancels it on its own |
| `attachAboveChars` | `7000` | a reply longer than this arrives as a `.txt` attachment |

When something takes longer than 8 seconds, the bot replies `Trabalhando nisso.`
and then repeats `Ainda trabalhando nisso (12min).` every `heartbeatMs` until
the result arrives, so a long job and a stuck one stop looking alike.

There is no time ceiling on an ordinary long job: one that needs an hour gets
an hour. The cost is that a stuck run holds its session until you send
`/stop`, so nothing queued behind it moves. Set `timeoutMs` in milliseconds if
you would rather have a cap. Every reply is prefixed with
`[session-name]`, because with parallel sessions they arrive out of order.

A reply longer than `attachAboveChars` — a diff, a log, a long report — does
not arrive as a run of message bubbles: it comes as a `<session>.txt`
attachment, with its opening lines in the caption so the gist is still
readable in the chat. If the attachment fails to send, the reply falls back
to plain message bubbles rather than being lost.

### A restart no longer eats your request

The prompt being run and the ones queued behind it are written to the state
file, not just held in memory, together with the id of the background agent
running it as soon as `claude --bg` hands one back.

The turn itself runs in claude's own background daemon, not in this process,
and the systemd unit stops only the Node process (`KillMode=process`) — so a
restart of the bot does not kill the work. On the next boot:

- if that agent is **still running**, the bot says so and picks it back up,
  delivering the reply when it finishes, as if nothing had happened;
- if it **already finished**, the reply is delivered;
- otherwise — a reboot, a crash that took the agent with it — the bot tells
  you which request never finished and offers `/retomar` to redo it or
  `/descartar` to forget it. Nothing is re-run on its own, because the dead
  run may already have had side effects.

The unit change only takes effect once it is reinstalled: rerun `./install.sh`
(it copies the unit and reloads systemd).

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

The background agent only runs for the duration of one turn: as soon as its
reply is read, claude-wpp stops it (`claude stop`), so no process is left
resident between messages. The next message starts a fresh one with
`--resume`, which rebuilds everything from the transcript regardless of
whether the previous one is still around — resuming a session whose process
has already fully exited (rather than one merely left idle) forks into a new
conversation id, and claude-wpp follows that id from then on.

There is no way to write into a live agent from the CLI (`claude` has
`attach`, `logs`, `stop`, `rm`, `respawn` — nothing that sends a turn), so
every message necessarily resumes into a fork. On a conversation of yours,
that fork runs under a name of its own — `infra-wpp` beside your `infra` —
and **stays listed** after the turn, so the bot's side of the conversation is
somewhere you can see and `claude attach`. Only one: the previous one is
swept when the next message arrives.

**It cleans up its own forks, and never your session.** Each turn resumes
into a fork with a new id, so the entries it creates are swept when the turn
ends — otherwise a new `infra` would appear in `claude agents` after every
message, and the next dispatch could no longer tell which one is yours. A
conversation you opened yourself is exempt: once a name has been adopted from
it, that id is neither stopped nor removed, ever. It used to be swept along
with the rest, which is how a session you opened vanished the first time the
bot answered on it.

### A name means your session

`@name` (and the assistant's own dispatch) looks at the sessions running on
this host before its own registry. One match and the name is pointed at it for
good, so `@infra` keeps meaning the `infra` you opened, across restarts, and
you are told once when it moves. Two sessions with that name, and it asks
which folder rather than guessing; a `done` one is skipped, since resuming a
session whose process is gone has been seen to hang. Because resuming forks
the conversation into a new id, the origin is remembered — otherwise the next
message would adopt the original again and fork from the same point, losing
everything said in between.

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

`state: failed` gets the same fresh-reply check first — it too has been seen
misreporting a turn that actually finished normally. Past that, it is treated
as final rather than given `blockedTimeoutMs`'s benefit of the doubt: `failed`
does not recover on its own the way `blocked` sometimes does, and it most
commonly means the id claude-wpp tried to `--resume` no longer exists on
claude's side. That id is dropped from the session right away so the *next*
message starts a fresh conversation instead of repeating the same failure
forever — the alternative to dropping it is a session that can never recover
without `/end` and `/new` by hand.

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

Every draft Claude proposes carries **two wordings**: yours, the way you write
to that person, which `/ok` sends from your account; and a formal one, which
`/bot` sends from the bot's number — through the bot it is always formal. The
preview shows each next to its command. A draft without a formal version (an
older one, or one you `/edit`ed — the edit discards the formal text written
from the old words) is rewritten formally at the moment you send `/bot`; if
that rewrite fails, nothing is approved.

`POST /wpp` also takes a file (`"attachment": {"fileName", "content"}`, base64):
it is kept under the media directory and Claude attaches it to the draft.
Drafts can only carry files from that directory.

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

Add `"send": "me"` or `"send": "bot"` to `POST /wpp` and the draft it produces
may skip that wait: the session composes as usual and, if it is sure of the
recipient and the content, proposes with `--send-as`, which approves and sends
at once — as you, or the formal wording through the bot. WhatsApp still gets
a `📤` note with what went out and `/undo`. The permission is held by the
server, not by the session: one per request, for that sender only, for 30
minutes. So a conversation the session reads cannot talk it into sending on
its own — without a matching open grant, `sendAs` on `/outbox` lands as an
ordinary draft (with a `warning`), and a session in any doubt proposes one
anyway.

`POST /send-file` is `/send` for a file — also as the bot, immediately. The
file travels base64-encoded in the body, so it works from any machine that
holds the token, not only this one. Up to roughly 16 MB; the mimetype is taken
from the extension unless you pass one, and `fileName` must be a bare name,
not a path:

```bash
jq -n --arg to 5511911111111 --arg fileName report.pdf --arg caption 'here it is' \
      --rawfile content <(base64 -w0 report.pdf) \
      '{to:$to, fileName:$fileName, caption:$caption, content:$content}' \
  | curl -X POST $HOST/send-file \
      -H "authorization: Bearer $TOKEN" \
      -H 'content-type: application/json' \
      --data-binary @-
```

`--rawfile` instead of `--arg` keeps a large file off the command line, where
it would hit the shell's argument-size limit.

In both `/send` and `/send-file`, `to` can be a **contact or group name**
instead of a number — useful from another machine, which has no way to look
the number up. It is resolved against the personal account's chats (so that
account has to be paired), ignoring case and accents: `"fulano bailão"` finds
`Fulano Bailāo`. An exact name wins; otherwise every word has to appear in the
name. Exactly one match is sent, and the response names it
(`{"ok":true,"to":"Fulano Bailāo"}`); several matches are a `409` listing up to
five `candidates` and nothing is sent; none is a `404`.

Add `"confirm": true` to either route and nothing is sent at all: the message
— or the file, kept under the media directory until then — becomes a draft,
it shows up on WhatsApp, and you decide there who it goes out as: `/ok <n>`
sends it **as you**, from your own account; `/bot <n>` from the bot's number;
`/no <n>` drops it. The response is `202` with the draft number. This needs the
personal account paired (`503` otherwise). Without `confirm`, both routes keep
sending immediately as the bot.

`POST /outbox` proposes a draft directly. It never sends either: the draft waits
for `/ok` on WhatsApp. It is how `agent/propose.mjs` works, and the only write
path Claude is given.

### Replies to the bot

When someone the bot has written to — through `/send`, `/send-file` or a
draft approved with `/bot` — answers it, the message is triaged first.

- Something that needs nobody — thanks, a compliment, a greeting, "got it" —
  the bot answers by itself, formally, and tells you what it said.
- Anything else — a request, a question, a deadline, an invitation, anything
  that needs your information, opinion, decision or word, and **every** doubt
  or failure — reaches you numbered, with a one-line note of what they want.
  Quote it (or send `/r <n> <text>`) to answer: your text, typed or dictated,
  is rewritten in formal Portuguese by Claude and sent from the bot's number
  right away. If the rewrite fails, nothing is sent — your raw words never go
  out through the bot.

Both the triage and the formal rewrite read the bot's conversation with that
person (`bot_messages`), so the bot continues a conversation instead of
greeting them again on every message. The `/wpp` session reads the same table
when it writes a `--body-bot`.

The triage model is the one place a third party's words reach Claude. It runs
with **no tools at all** (`claude -p --tools ''`), sees only that one
conversation, and can produce exactly two outcomes: one message back to that
same person, or "tell the owner". It cannot reach a session, your own
WhatsApp, the API or this machine, and a message trying to talk it into any
of that is a reason to alert you, not to comply. Anything it answers that is
not a clear decision falls back to alerting you.

Only people the bot has written to are relayed; anyone else writing to the
bot is ignored, as before, and groups never are. A sender that arrives only
as an `@lid`, without their number alongside, cannot be matched and is not
relayed.

### Alerts: `POST /notify`

A channel for other machines and scripts — CI, a deploy, a cron check — to
reach you. It always goes to `authorizedNumber`, so the caller does not need
to know it:

```bash
curl -X POST $HOST/notify \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"text":"disk at 91% on /","source":"srv1","key":"disk-srv1"}'
```

Arrives as `🔔 [srv1] disk at 91% on /`. `source` is optional. `key` is
optional too, and it is what keeps a check that fails every minute from
pinging you sixty times: repeats of the same `key` inside `notifyDedupMs` are
dropped and answered with `"deduped": true`. Only a delivered alert starts
that window — if WhatsApp is down the call returns `502`, and the retry goes
through.

A disk check from cron, for example:

```bash
uso=$(df --output=pcent / | tail -1 | tr -dc 0-9)
[ "$uso" -ge 90 ] && curl -s -X POST $HOST/notify \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d "{\"text\":\"disk at ${uso}% on /\",\"source\":\"$(hostname)\",\"key\":\"disk\"}"
```

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
| `notifyDedupMs` | `600000` (10 min) | window in which `POST /notify` drops repeats of the same `key` |

## Operation

```bash
systemctl --user status claude-wpp
journalctl --user -u claude-wpp -f
systemctl --user restart claude-wpp
```

State lives in `~/.local/state/claude-wpp/`. The conversation history belongs to
Claude Code, under `~/.claude/projects/` — restarting the service loses no
session.

### Knowing when the bot itself is down

When the bot's WhatsApp is down, WhatsApp cannot tell you so. A separate
systemd timer (`claude-wpp-health.timer`, installed and enabled by
`./install.sh`) checks `/healthz` every 2 minutes and alerts through
[ntfy](https://ntfy.sh) instead: set `ntfyTopic` in `config.json` and subscribe
to that topic in the ntfy app. Without it, the check does nothing.

It alerts once when the bot has been unreachable — API down, or its WhatsApp
not `open` — for two checks in a row (a single failed look is usually just a
reconnect), and once more when it is back. An alert that could not be
delivered is retried on the next check.

```bash
systemctl --user list-timers claude-wpp-health.timer
journalctl --user -u claude-wpp-health -n 20
```

| Key | Default | What it does |
|---|---|---|
| `ntfyTopic` | `null` | ntfy.sh topic for "bot down" / "bot back" alerts; off while unset |

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
