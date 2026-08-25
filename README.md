# claude-wpp

Claude Code over WhatsApp, with several parallel sessions, using the
subscription already authenticated on this host. It does not consume the paid
API.

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
