## What this changes

<!-- One or two sentences. What behaviour is different after this PR? -->

## Why

<!-- The problem being solved. Link the issue if there is one: Closes #123 -->

## How it was verified

<!-- Not "it should work". What did you run, and what did it print? -->

- [ ] `npm test` passes locally
- [ ] Manually exercised over WhatsApp, if the change touches `whatsapp.js`,
      `handler.js` or `router.js`

## Checklist

- [ ] No real phone numbers, e-mail addresses, tokens or absolute home paths
      in the diff — this repo uses documentation placeholders only
      (`5511911111111`, `fulano@example.com`, `%h`)
- [ ] Comments and documentation are in English
- [ ] New behaviour has a test, or the PR explains why it cannot have one
- [ ] `SECURITY.md` still describes the threat model after this change

## Security impact

<!-- This project runs Claude with permission checks disabled. Any change to
     authorization, number matching, the HTTP API or process spawning is a
     security change. Say so explicitly, or write "none". -->
