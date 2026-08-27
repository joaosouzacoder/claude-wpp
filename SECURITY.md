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

### Audio transcription sends data to a third party

Audio support is the only feature that leaves the host. If `openaiApiKey` is
set, every voice note received is uploaded to the OpenAI transcription API, and
is therefore subject to OpenAI's retention and processing terms rather than
this project's. The upload happens only after the sender has been checked
against `authorizedNumber`, and the local copy is deleted as soon as the
transcript returns — but the transcript itself becomes a Claude prompt, so
treat a dictated instruction exactly like a typed one.

Leave `openaiApiKey` unset to keep audio off and the host silent. Images are
never uploaded anywhere: they stay on local disk and Claude reads them there.

### The personal account records everything, and it is not your data alone

Pairing a personal account (`personalNumber` + `npm run pair:me`) turns the
service into a recorder. Every message that account sends or receives — direct
chats and groups alike — is written to `~/.local/state/claude-wpp/wpp.db` in
plain text, with no expiry. Media files are not downloaded; their text
placeholder is.

Three consequences, stated plainly:

- **The other people in those conversations did not agree to this.** You are a
  participant, so this is not interception, but a group of colleagues writing to
  what they believe is a phone is in fact writing to a database on a server.
  Weigh that before pairing an account used for work.
- **Deleting for everyone does not reach this log.** A message withdrawn on
  WhatsApp after it arrived here stays here. That is a deliberate omission, not
  an oversight.
- **The file is protected only by filesystem permissions.** It is `0600` and
  owned by the service user. Encrypting it with a key stored beside it would
  buy nothing, so the project does not pretend to.

Nothing in the recorder reaches the network. The log is read locally, by SQL,
and the only thing that leaves is a message you approved by hand.

### Automating a personal account risks losing it

Baileys is not an authorized WhatsApp client, and connecting an account to it
breaks the WhatsApp Terms of Service. The bot account has always carried that
risk; a personal account carries it with much worse consequences — a ban takes
the number, its groups and its history with it.

The risk is low for the traffic this project generates and it is not zero. The
project will not pair a personal account on its own: `npm run pair:me` is a
deliberate act, in the foreground, with the warning printed before the QR code.

### Claude proposes; only you send

Drafts arrive through `POST /outbox` and land as `pending`. A message is sent
only after an explicit `/ok <n>` from `authorizedNumber`, and a scheduled
conditional job may decide *whether* to send, never *what* to send — the text
was fixed when you approved it.

This protects against the model being wrong. It does not protect against the
model being hostile, nor against whoever controls the bot chat: Claude runs with
permissions disabled and can reach the API like anything else on the host. The
separation is a guardrail, not a sandbox.

### What it does not protect against

- A compromised authorized WhatsApp account.
- Anything the local user can already do — the service adds no privilege
  boundary of its own.
- Prompt injection reaching the model through file contents or command output.
  The model runs with permissions disabled; treat its reach as your own. With a
  personal account paired, that surface now includes anything anyone writes to
  you on WhatsApp: a message in a group is untrusted input that Claude will read
  when you ask it to.

If that trade is not acceptable for your host, do not deploy this.

## Handling personal data in contributions

Phone numbers, e-mail addresses and home paths must not appear in the tree or in
the commit history. Use `5511911111111` (authorized), `5511922222222` (bot),
`fulano@example.com` and `%h`. A PR that carries a real value will be asked to
rewrite it before merge, not just amend the tip.
