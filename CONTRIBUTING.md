# Contributing

Thanks for taking the time. This is a small, single-maintainer project, so the
bar is less about process and more about the change being verified.

## Before you start

For anything larger than a bug fix, open an issue first. The project has a
deliberately narrow scope — see *Out of scope* in
[the design spec](docs/superpowers/specs/2026-08-22-claude-wpp-design.md).
Multiple authorized numbers, multi-user support, a web interface and a database
were all considered and rejected; a PR adding them will be declined regardless
of quality.

If your change touches authorization, number matching, the HTTP API or process
spawning, read [SECURITY.md](SECURITY.md) first. Those are security changes.

## Setup

```bash
git clone https://github.com/joaosouzacoder/claude-wpp.git
cd claude-wpp
npm install
cp config.example.json config.json    # placeholders are fine for tests
npm test
```

Node 24 or newer. The test suite uses `node:test` — no framework, no watcher,
no config.

## Development

`router`, `sessions` and `store` are pure functions over state, and that is
where most of the tests live. `claude.js` is tested against a fake `claude`
executable injected into the test `PATH` (`test/fake-claude.sh`), which echoes a
controlled JSON. `whatsapp.js` and `api.js` are left to manual smoke testing —
mocking Baileys costs more than the test would deliver.

New behaviour needs a test, or an explanation of why it cannot have one.

## Style

The code has no linter and no formatter, on purpose. Match the file you are
editing: two-space indent, no semicolons, ESM imports, small modules with one
responsibility each.

Comments and documentation are in English. The bot's user-facing replies are
still Portuguese — that is the maintainer's UX, not an oversight, and changing
it is a product decision rather than a translation.

Do not reformat, rename or "improve" code your change does not touch. A diff
should read as one idea.

## Never commit personal data

This repository had its history rewritten once to remove real phone numbers and
an e-mail address. Do not put them back. Use the placeholders:

| Kind | Placeholder |
|---|---|
| Authorized number | `5511911111111` |
| Bot number | `5511922222222` |
| Legacy 8-digit form | `551111111111` |
| E-mail | `fulano@example.com` |
| Home path | `%h` in systemd units, `/home/user` in docs |

`config.json` is gitignored and holds the real values. It stays that way.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, optionally scoped —
`fix(numbers): tolerate the missing ninth digit`.

Write the body to explain *why*, not *what* — the diff already says what. Commit
messages are in English.

Fill in the pull request template honestly, especially the verification section.
"It should work" is not verification; the output of the command you ran is.

CI runs the test suite on every PR. It must be green before review.

## Code of conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).
