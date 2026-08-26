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
once and sends the result afterwards. Every reply is prefixed with
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

## Local API

```bash
curl -X POST localhost:8787/send \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"to":"5511911111111","text":"hi"}'

curl localhost:8787/healthz
```

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
