# Security Policy

## Reporting a vulnerability

Do not open a public issue.

Report through GitHub's private vulnerability reporting:
[open a security advisory](https://github.com/joaosouzacoder/claude-wpp/security/advisories/new).

Expect a first response within 7 days. If a fix is warranted, it lands on `main`
and the advisory is published with credit, unless you prefer otherwise.

## Supported versions

This is a single-maintainer project with no release branches. Only `main` is
supported. Fixes are not backported.

## Threat model — read this before deploying

This project is not a sandbox, and it is not trying to be one. Understand what
you are running before you point it at your machine.

**The service runs `claude` with `--dangerously-skip-permissions` and an
unrestricted working directory.** Any message from the authorized WhatsApp
number executes real commands on the host, as the user running the service,
with no confirmation step. There is no way to approve a permission prompt over
WhatsApp, which is why the prompt is disabled rather than answered.

The practical consequence: **whoever controls the authorized WhatsApp account
has a shell on your machine.** A stolen phone, a hijacked WhatsApp account or a
SIM swap is a full host compromise, not a messaging inconvenience.

### What the project does to narrow that

- **One authorized number.** `authorizedNumber` is required — there is no
  default and no wildcard. Every other sender is dropped.
- **Silence to unknown senders.** An unauthorized message gets a debug log and
  no reply. The service does not confirm its own existence.
- **JID normalization before comparison.** Numbers are reduced to digits and the
  Brazilian ninth-digit variance is tolerated, so a legacy-format sender still
  matches — and two different area codes never do. Group messages and `fromMe`
  messages are discarded.
- **The HTTP API is bound to `127.0.0.1`** and `POST /send` requires a bearer
  token. `GET /healthz` does not, and returns no sensitive data.
- **No credentials in the repo.** `config.json` is gitignored; the WhatsApp
  session state lives in `~/.local/state/claude-wpp/` and never enters the tree.

### What it does not protect against

- A compromised authorized WhatsApp account.
- Anything the local user can already do — the service adds no privilege
  boundary of its own.
- Prompt injection reaching the model through file contents or command output.
  The model runs with permissions disabled; treat its reach as your own.

If that trade is not acceptable for your host, do not deploy this.

## Handling personal data in contributions

Phone numbers, e-mail addresses and home paths must not appear in the tree or in
the commit history. Use `5511911111111` (authorized), `5511922222222` (bot),
`fulano@example.com` and `%h`. A PR that carries a real value will be asked to
rewrite it before merge, not just amend the tip.
