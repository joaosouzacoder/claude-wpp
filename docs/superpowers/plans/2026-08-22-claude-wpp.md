# claude-wpp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conversar com o Claude Code pelo WhatsApp, com várias sessões independentes e paralelas, reaproveitando a subscription já autenticada neste host.

**Architecture:** Processo Node único. O WhatsApp entra via Baileys, o roteador decide a sessão, e cada mensagem vira um `claude -p --resume <session_id>` de vida curta. O estado da conversa mora em `~/.claude/projects/` (do próprio Claude Code), então o daemon é descartável e pode reiniciar sem perder nada. Uma API HTTP local expõe apenas o envio de mensagem.

**Tech Stack:** Node 24 (ESM), `@whiskeysockets/baileys`, `qrcode-terminal`, `node:test`, `node:http`, systemd user service.

**Spec:** `docs/superpowers/specs/2026-08-22-claude-wpp-design.md`

## Global Constraints

- Node >= 24, ESM (`"type": "module"`). Nada de TypeScript, nada de build step.
- Dependências de produção permitidas: **apenas** `@whiskeysockets/baileys` e `qrcode-terminal`. Zero dependências de desenvolvimento — testes usam `node:test`.
- Número autorizado, único: `5511911111111`. Número do bot (aparelho pareado): `5511922222222`.
- API HTTP presa a `127.0.0.1:8787`. Token bearer: lido de `config.json` (`apiToken`) — o mesmo que a skill `send-whatsapp` já usa. O valor nunca aparece no repositório.
- Aviso de demora, texto exato: `Trabalhando nisso.` — disparado após 8000 ms, no máximo uma vez por mensagem.
- Timeout duro por mensagem: 900000 ms (15 min).
- Tamanho máximo de mensagem enviada ao WhatsApp: 3500 caracteres.
- Diretório de estado: `~/.local/state/claude-wpp/`.
- Binário do Claude no systemd: `/home/user/.local/bin/claude`. Binário do Node: `/home/user/.asdf/installs/nodejs/24.15.0/bin/node`.
- Toda **resposta do Claude** enviada ao WhatsApp é prefixada com `[nome-da-sessão] `. O aviso `Trabalhando nisso.` vai sem prefixo.
- Mensagens em português. Commits em inglês, sem assinatura de AI.
- Arquivos de teste ficam em `test/<modulo>.test.js` e rodam com `npm test`.

---

### Task 1: Scaffold e configuração

**Files:**
- Create: `package.json`
- Create: `config.example.json`
- Create: `src/config.js`
- Test: `test/config.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `loadConfig({ path, env }) -> Config`, onde `Config` é
  `{ authorizedNumber, botNumber, apiHost, apiPort, apiToken, stateDir, claudeBin, defaultCwd, slowNoticeMs, timeoutMs, maxMessageChars }`.
  Lança `Error` se `apiToken` estiver ausente.

- [ ] **Step 1: Criar o `package.json`**

```json
{
  "name": "claude-wpp",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=24" },
  "scripts": {
    "start": "node src/index.js",
    "pair": "node src/pair.js",
    "test": "node --test test/"
  }
}
```

- [ ] **Step 2: Instalar as dependências**

Deixe o npm resolver as versões — não fixe à mão.

Run: `cd ~/claude-wpp && npm install @whiskeysockets/baileys qrcode-terminal`
Expected: `node_modules/` criado, `package.json` ganha o bloco `dependencies`, `package-lock.json` criado.

- [ ] **Step 3: Escrever o teste que falha**

Crie `test/config.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { loadConfig } from '../src/config.js'

function fixture(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'cfg-'))
  const path = join(dir, 'config.json')
  writeFileSync(path, JSON.stringify(obj))
  return path
}

test('aplica os defaults quando o arquivo só traz o token', () => {
  const cfg = loadConfig({ path: fixture({ apiToken: 'abc' }), env: {} })
  assert.equal(cfg.apiToken, 'abc')
  assert.equal(cfg.authorizedNumber, '5511911111111')
  assert.equal(cfg.apiHost, '127.0.0.1')
  assert.equal(cfg.apiPort, 8787)
  assert.equal(cfg.slowNoticeMs, 8000)
  assert.equal(cfg.timeoutMs, 900000)
  assert.equal(cfg.maxMessageChars, 3500)
  assert.equal(cfg.claudeBin, 'claude')
  assert.equal(cfg.defaultCwd, homedir())
  assert.equal(cfg.stateDir, join(homedir(), '.local', 'state', 'claude-wpp'))
})

test('o arquivo sobrescreve os defaults', () => {
  const cfg = loadConfig({ path: fixture({ apiToken: 'abc', apiPort: 9999 }), env: {} })
  assert.equal(cfg.apiPort, 9999)
})

test('a variável de ambiente vence o arquivo', () => {
  const cfg = loadConfig({
    path: fixture({ apiToken: 'abc', apiPort: 9999 }),
    env: { CLAUDE_WPP_API_PORT: '7777', CLAUDE_WPP_API_TOKEN: 'do-env' },
  })
  assert.equal(cfg.apiPort, 7777)
  assert.equal(cfg.apiToken, 'do-env')
})

test('falha explicitamente quando não há token', () => {
  assert.throws(
    () => loadConfig({ path: fixture({}), env: {} }),
    /apiToken/,
  )
})

test('falha explicitamente quando o arquivo não existe', () => {
  assert.throws(
    () => loadConfig({ path: '/caminho/que/nao/existe.json', env: {} }),
    /config/i,
  )
})
```

- [ ] **Step 4: Rodar o teste e confirmar que falha**

Run: `cd ~/claude-wpp && npm test`
Expected: FAIL — `Cannot find module '../src/config.js'`.

- [ ] **Step 5: Implementar `src/config.js`**

```js
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULTS = {
  authorizedNumber: '5511911111111',
  botNumber: '5511922222222',
  apiHost: '127.0.0.1',
  apiPort: 8787,
  apiToken: null,
  stateDir: join(homedir(), '.local', 'state', 'claude-wpp'),
  claudeBin: 'claude',
  defaultCwd: homedir(),
  slowNoticeMs: 8000,
  timeoutMs: 900000,
  maxMessageChars: 3500,
}

const ENV_MAP = {
  CLAUDE_WPP_API_HOST: ['apiHost', String],
  CLAUDE_WPP_API_PORT: ['apiPort', Number],
  CLAUDE_WPP_API_TOKEN: ['apiToken', String],
  CLAUDE_WPP_STATE_DIR: ['stateDir', String],
  CLAUDE_WPP_CLAUDE_BIN: ['claudeBin', String],
  CLAUDE_WPP_DEFAULT_CWD: ['defaultCwd', String],
}

export function loadConfig({ path = join(homedir(), 'claude-wpp', 'config.json'), env = process.env } = {}) {
  let file
  try {
    file = JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new Error(`Não consegui ler o config em ${path}: ${err.message}`)
  }

  const cfg = { ...DEFAULTS, ...file }

  for (const [key, [field, cast]] of Object.entries(ENV_MAP)) {
    if (env[key] != null && env[key] !== '') cfg[field] = cast(env[key])
  }

  if (!cfg.apiToken) throw new Error('config inválido: apiToken é obrigatório')

  return cfg
}
```

- [ ] **Step 6: Criar o `config.example.json`**

```json
{
  "apiToken": "troque-por-um-token-forte",
  "authorizedNumber": "5511911111111",
  "botNumber": "5511922222222"
}
```

- [ ] **Step 7: Rodar os testes e confirmar que passam**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 5 testes.

- [ ] **Step 8: Commit**

```bash
cd ~/claude-wpp
git add package.json package-lock.json config.example.json src/config.js test/config.test.js
git commit -m "Add project scaffold and config loader"
```

---

### Task 2: Persistência de estado

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `createStore(filePath) -> { load(), save(state) }`.
  `load()` devolve `{ sessions: [], activeSession: null }` quando o arquivo não
  existe ou está corrompido. `save(state)` grava de forma atômica, criando o
  diretório se preciso.

- [ ] **Step 1: Escrever o teste que falha**

Crie `test/store.test.js`:

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/store.js'

const fresh = () => join(mkdtempSync(join(tmpdir(), 'store-')), 'sub', 'state.json')

test('devolve o estado vazio quando o arquivo não existe', () => {
  const store = createStore(fresh())
  assert.deepEqual(store.load(), { sessions: [], activeSession: null })
})

test('devolve o estado vazio quando o arquivo está corrompido', () => {
  const path = fresh()
  const store = createStore(path)
  store.save({ sessions: [], activeSession: null })
  writeFileSync(path, '{ isso não é json')
  assert.deepEqual(store.load(), { sessions: [], activeSession: null })
})

test('grava e relê o estado, criando o diretório', () => {
  const path = fresh()
  const store = createStore(path)
  const state = { sessions: [{ name: 'api', cwd: '/tmp', claudeSessionId: 'x' }], activeSession: 'api' }
  store.save(state)
  assert.ok(existsSync(path))
  assert.deepEqual(store.load(), state)
})

test('não deixa arquivo temporário para trás', () => {
  const path = fresh()
  const store = createStore(path)
  store.save({ sessions: [], activeSession: null })
  const sobras = readdirSync(join(path, '..')).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(sobras, [])
})
```

- [ ] **Step 2: Rodar o teste e confirmar que falha**

Run: `cd ~/claude-wpp && npm test`
Expected: FAIL — `Cannot find module '../src/store.js'`.

- [ ] **Step 3: Implementar `src/store.js`**

```js
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'

const VAZIO = { sessions: [], activeSession: null }

export function createStore(filePath) {
  return {
    load() {
      try {
        const raw = JSON.parse(readFileSync(filePath, 'utf8'))
        return {
          sessions: Array.isArray(raw.sessions) ? raw.sessions : [],
          activeSession: typeof raw.activeSession === 'string' ? raw.activeSession : null,
        }
      } catch {
        return structuredClone(VAZIO)
      }
    },

    save(state) {
      mkdirSync(dirname(filePath), { recursive: true })
      const tmp = `${filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(state, null, 2))
      renameSync(tmp, filePath)
    },
  }
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 9 testes no total.

- [ ] **Step 5: Commit**

```bash
cd ~/claude-wpp
git add src/store.js test/store.test.js
git commit -m "Add atomic JSON state store"
```

---

### Task 3: Normalização de número e quebra de texto

Duas funções puras, sem dependências, que precisam estar corretas antes de
qualquer coisa tocar o WhatsApp. A de número é o controle de acesso do sistema.

**Files:**
- Create: `src/numbers.js`
- Create: `src/text.js`
- Test: `test/numbers.test.js`
- Test: `test/text.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `normalizeNumber(jidOuNumero) -> string` (só dígitos).
  - `sameNumber(a, b) -> boolean` (tolera o nono dígito brasileiro).
  - `senderNumber(key) -> string | null` — extrai o telefone da `key` de uma
    mensagem Baileys; devolve `null` quando só há um `@lid` (falha fechada).
  - `chunkText(texto, max) -> string[]` — nunca devolve array vazio.

- [ ] **Step 1: Escrever `test/numbers.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeNumber, sameNumber, senderNumber } from '../src/numbers.js'

test('normalizeNumber tira sufixo de jid, device e pontuação', () => {
  assert.equal(normalizeNumber('5511911111111@s.whatsapp.net'), '5511911111111')
  assert.equal(normalizeNumber('5511911111111:12@s.whatsapp.net'), '5511911111111')
  assert.equal(normalizeNumber('+55 (11) 91111-1111'), '5511911111111')
})

test('sameNumber compara números idênticos', () => {
  assert.ok(sameNumber('5511911111111@s.whatsapp.net', '5511911111111'))
})

test('sameNumber tolera a ausência do nono dígito', () => {
  assert.ok(sameNumber('551111111111@s.whatsapp.net', '5511911111111'))
  assert.ok(sameNumber('5511911111111', '551111111111'))
})

test('sameNumber recusa números diferentes', () => {
  assert.equal(sameNumber('5511999999999', '5511911111111'), false)
  assert.equal(sameNumber('', '5511911111111'), false)
  assert.equal(sameNumber(null, '5511911111111'), false)
})

test('sameNumber não confunde números que só diferem no dígito removido', () => {
  // 5511 9 1111-1111 sem o 9 é 5511 1111-1111; um terceiro número real
  // com esses mesmos 8 dígitos finais mas DDD diferente não pode casar
  assert.equal(sameNumber('5521911111111', '5511911111111'), false)
})

test('senderNumber prefere o telefone quando o remoteJid é um lid', () => {
  assert.equal(
    senderNumber({ remoteJid: '123456789@lid', senderPn: '5511911111111@s.whatsapp.net' }),
    '5511911111111',
  )
  assert.equal(
    senderNumber({ remoteJid: '123456789@lid', remoteJidAlt: '5511911111111@s.whatsapp.net' }),
    '5511911111111',
  )
})

test('senderNumber devolve null quando só existe lid', () => {
  assert.equal(senderNumber({ remoteJid: '123456789@lid' }), null)
})

test('senderNumber usa o remoteJid comum', () => {
  assert.equal(senderNumber({ remoteJid: '5511911111111@s.whatsapp.net' }), '5511911111111')
})
```

- [ ] **Step 2: Escrever `test/text.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chunkText } from '../src/text.js'

test('texto curto vira um pedaço só', () => {
  assert.deepEqual(chunkText('oi', 100), ['oi'])
})

test('texto vazio ainda devolve um pedaço', () => {
  assert.deepEqual(chunkText('', 100), [''])
})

test('quebra preferindo a quebra de linha', () => {
  const texto = 'aaaa\nbbbb\ncccc'
  const partes = chunkText(texto, 10)
  assert.ok(partes.length > 1)
  assert.ok(partes.every((p) => p.length <= 10))
  assert.equal(partes.join('\n'), texto)
})

test('quebra à força quando uma linha é maior que o limite', () => {
  const partes = chunkText('x'.repeat(25), 10)
  assert.deepEqual(partes, ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)])
})

test('nenhum pedaço ultrapassa o limite', () => {
  const texto = Array.from({ length: 50 }, (_, i) => `linha ${i} com algum conteúdo`).join('\n')
  for (const parte of chunkText(texto, 120)) assert.ok(parte.length <= 120)
})
```

- [ ] **Step 3: Rodar e confirmar que falham**

Run: `cd ~/claude-wpp && npm test`
Expected: FAIL — módulos `../src/numbers.js` e `../src/text.js` não existem.

- [ ] **Step 4: Implementar `src/numbers.js`**

```js
export function normalizeNumber(entrada) {
  if (entrada == null) return ''
  return String(entrada).split('@')[0].split(':')[0].replace(/\D/g, '')
}

// Celular brasileiro: 55 + DDD (2) + 9 + 8 dígitos. O WhatsApp às vezes entrega
// o formato antigo, sem o nono dígito. Removemos o 9 dos dois lados antes de
// comparar — mantendo país e DDD intactos, para não casar números de DDDs
// diferentes.
function semNonoDigito(digitos) {
  return /^55\d{2}9\d{8}$/.test(digitos) ? digitos.slice(0, 4) + digitos.slice(5) : digitos
}

export function sameNumber(a, b) {
  const x = normalizeNumber(a)
  const y = normalizeNumber(b)
  if (!x || !y) return false
  if (x === y) return true
  return semNonoDigito(x) === semNonoDigito(y)
}

// Em versões recentes do Baileys o remoteJid pode ser um "@lid", que não é
// telefone. Nesse caso só aceitamos a mensagem se o telefone real vier junto.
export function senderNumber(key = {}) {
  const candidatos = [key.senderPn, key.remoteJidAlt, key.participantPn, key.participant, key.remoteJid]
  for (const jid of candidatos) {
    if (typeof jid === 'string' && !jid.includes('@lid')) {
      const digitos = normalizeNumber(jid)
      if (digitos) return digitos
    }
  }
  return null
}
```

- [ ] **Step 5: Implementar `src/text.js`**

```js
export function chunkText(texto, max) {
  const str = String(texto ?? '')
  if (str.length <= max) return [str]

  const partes = []
  let atual = ''

  for (const linha of str.split('\n')) {
    if (linha.length > max) {
      if (atual) {
        partes.push(atual)
        atual = ''
      }
      for (let i = 0; i < linha.length; i += max) partes.push(linha.slice(i, i + max))
      continue
    }
    const candidato = atual ? `${atual}\n${linha}` : linha
    if (candidato.length > max) {
      partes.push(atual)
      atual = linha
    } else {
      atual = candidato
    }
  }

  if (atual) partes.push(atual)
  return partes.length ? partes : ['']
}
```

- [ ] **Step 6: Rodar os testes e confirmar que passam**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 22 testes no total.

- [ ] **Step 7: Commit**

```bash
cd ~/claude-wpp
git add src/numbers.js src/text.js test/numbers.test.js test/text.test.js
git commit -m "Add phone number matching and message chunking helpers"
```

---

### Task 4: Parser de comandos

**Files:**
- Create: `src/router.js`
- Test: `test/router.test.js`

**Interfaces:**
- Consumes: nada.
- Produces: `parse(texto)` devolvendo um destes formatos:
  - `{ type: 'command', name: string, args: string[] }`
  - `{ type: 'message', target: string | null, text: string }`
  - `{ type: 'error', message: string }`

- [ ] **Step 1: Escrever `test/router.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parse } from '../src/router.js'

test('texto solto vai para a sessão ativa', () => {
  assert.deepEqual(parse('roda os testes'), { type: 'message', target: null, text: 'roda os testes' })
})

test('apara espaços em volta', () => {
  assert.deepEqual(parse('  oi  '), { type: 'message', target: null, text: 'oi' })
})

test('comando sem argumento', () => {
  assert.deepEqual(parse('/ls'), { type: 'command', name: 'ls', args: [] })
})

test('comando com argumentos', () => {
  assert.deepEqual(parse('/new ~/work/api api'), {
    type: 'command', name: 'new', args: ['~/work/api', 'api'],
  })
})

test('comando é case-insensitive', () => {
  assert.deepEqual(parse('/LS'), { type: 'command', name: 'ls', args: [] })
})

test('@nome roteia sem trocar a ativa', () => {
  assert.deepEqual(parse('@infra checa o disco'), {
    type: 'message', target: 'infra', text: 'checa o disco',
  })
})

test('@nome preserva múltiplas linhas do texto', () => {
  assert.deepEqual(parse('@api arruma\nisso aqui'), {
    type: 'message', target: 'api', text: 'arruma\nisso aqui',
  })
})

test('@nome sozinho é erro explícito', () => {
  const r = parse('@api')
  assert.equal(r.type, 'error')
  assert.match(r.message, /@nome/)
})

test('e-mail no meio do texto não vira roteamento', () => {
  assert.deepEqual(parse('manda pro fulano@example.com'), {
    type: 'message', target: null, text: 'manda pro fulano@example.com',
  })
})

test('barra sozinha é mensagem, não comando', () => {
  assert.equal(parse('/').type, 'error')
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd ~/claude-wpp && npm test`
Expected: FAIL — `Cannot find module '../src/router.js'`.

- [ ] **Step 3: Implementar `src/router.js`**

```js
const NOME = /^[a-z0-9_-]{1,24}$/i

export function parse(entrada) {
  const texto = String(entrada ?? '').trim()

  if (texto.startsWith('/')) {
    const [cru, ...args] = texto.slice(1).split(/\s+/).filter(Boolean)
    if (!cru) return { type: 'error', message: 'Comando vazio. Manda /help.' }
    return { type: 'command', name: cru.toLowerCase(), args }
  }

  if (texto.startsWith('@')) {
    const casou = texto.match(/^@([a-z0-9_-]{1,24})\s+([\s\S]+)$/i)
    if (casou) return { type: 'message', target: casou[1], text: casou[2].trim() }
    const sozinho = texto.slice(1)
    if (NOME.test(sozinho)) {
      return { type: 'error', message: 'Faltou o texto. Uso: @nome sua mensagem' }
    }
  }

  return { type: 'message', target: null, text: texto }
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 32 testes no total.

- [ ] **Step 5: Commit**

```bash
cd ~/claude-wpp
git add src/router.js test/router.test.js
git commit -m "Add WhatsApp command parser"
```

---

### Task 5: Registry de sessões

**Files:**
- Create: `src/sessions.js`
- Test: `test/sessions.test.js`

**Interfaces:**
- Consumes: `createStore` da Task 2.
- Produces: `createSessions({ store, defaultCwd }) -> registry` com:
  - `create({ cwd, name }) -> session` (lança em nome duplicado, nome inválido ou cwd inexistente)
  - `list() -> session[]`
  - `get(name) -> session | undefined`
  - `active() -> session | undefined`
  - `setActive(name) -> boolean`
  - `end(name) -> boolean`
  - `touch(name) -> void`

  Uma `session` é
  `{ name, cwd, claudeSessionId, createdAt, lastActivityAt, busy, queue, abort }`.
  Os campos `busy`, `queue` e `abort` são de runtime e **não** são persistidos.

- [ ] **Step 1: Escrever `test/sessions.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createStore } from '../src/store.js'
import { createSessions } from '../src/sessions.js'

const novo = () => {
  const dir = mkdtempSync(join(tmpdir(), 'sess-'))
  const store = createStore(join(dir, 'state.json'))
  return { store, dir, sessions: createSessions({ store, defaultCwd: dir }) }
}

test('a primeira sessão criada vira a ativa', () => {
  const { sessions, dir } = novo()
  const s = sessions.create({ cwd: dir, name: 'api' })
  assert.equal(s.name, 'api')
  assert.equal(s.cwd, dir)
  assert.equal(s.claudeSessionId, null)
  assert.equal(s.busy, false)
  assert.equal(sessions.active().name, 'api')
})

test('gera nome automático quando não informado', () => {
  const { sessions, dir } = novo()
  assert.equal(sessions.create({ cwd: dir }).name, 's1')
  assert.equal(sessions.create({ cwd: dir }).name, 's2')
})

test('nome automático não colide com nome manual', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 's1' })
  assert.equal(sessions.create({ cwd: dir }).name, 's2')
})

test('usa o defaultCwd quando não informado', () => {
  const { sessions, dir } = novo()
  assert.equal(sessions.create({}).cwd, dir)
})

test('expande o til no cwd', () => {
  const { sessions } = novo()
  assert.equal(sessions.create({ cwd: '~' }).cwd, homedir())
})

test('recusa nome duplicado', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'api' })
  assert.throws(() => sessions.create({ cwd: dir, name: 'api' }), /já existe/)
})

test('recusa nome inválido', () => {
  const { sessions, dir } = novo()
  assert.throws(() => sessions.create({ cwd: dir, name: 'com espaço' }), /nome inválido/i)
})

test('recusa cwd inexistente', () => {
  const { sessions } = novo()
  assert.throws(() => sessions.create({ cwd: '/nao/existe/mesmo' }), /não existe/)
})

test('setActive troca a ativa e recusa nome desconhecido', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'a' })
  sessions.create({ cwd: dir, name: 'b' })
  assert.equal(sessions.active().name, 'b')
  assert.equal(sessions.setActive('a'), true)
  assert.equal(sessions.active().name, 'a')
  assert.equal(sessions.setActive('zzz'), false)
  assert.equal(sessions.active().name, 'a')
})

test('encerrar a ativa promove outra sessão', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'a' })
  sessions.create({ cwd: dir, name: 'b' })
  assert.equal(sessions.end('b'), true)
  assert.equal(sessions.active().name, 'a')
})

test('encerrar a última sessão deixa a ativa nula', () => {
  const { sessions, dir } = novo()
  sessions.create({ cwd: dir, name: 'a' })
  sessions.end('a')
  assert.equal(sessions.active(), undefined)
  assert.deepEqual(sessions.list(), [])
})

test('estado sobrevive a um restart, sem campos de runtime', () => {
  const { store, sessions, dir } = novo()
  const s = sessions.create({ cwd: dir, name: 'api' })
  s.claudeSessionId = 'uuid-123'
  s.busy = true
  s.queue.push('nao devia persistir')
  sessions.touch('api')

  const bruto = store.load()
  assert.equal(bruto.sessions[0].claudeSessionId, 'uuid-123')
  assert.equal(bruto.sessions[0].busy, undefined)
  assert.equal(bruto.sessions[0].queue, undefined)

  const revividas = createSessions({ store, defaultCwd: dir })
  const r = revividas.get('api')
  assert.equal(r.claudeSessionId, 'uuid-123')
  assert.equal(r.busy, false)
  assert.deepEqual(r.queue, [])
  assert.equal(revividas.active().name, 'api')
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd ~/claude-wpp && npm test`
Expected: FAIL — `Cannot find module '../src/sessions.js'`.

- [ ] **Step 3: Implementar `src/sessions.js`**

```js
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const NOME_VALIDO = /^[a-z0-9_-]{1,24}$/i

function expandir(cwd, defaultCwd) {
  const bruto = cwd?.trim() ? cwd.trim() : defaultCwd
  const expandido = bruto === '~' ? homedir() : bruto.replace(/^~\//, `${homedir()}/`)
  const absoluto = resolve(defaultCwd, expandido)
  let info
  try {
    info = statSync(absoluto)
  } catch {
    throw new Error(`o diretório ${absoluto} não existe`)
  }
  if (!info.isDirectory()) throw new Error(`${absoluto} não é um diretório`)
  return absoluto
}

const PERSISTIDO = ['name', 'cwd', 'claudeSessionId', 'createdAt', 'lastActivityAt']

export function createSessions({ store, defaultCwd = homedir(), now = () => new Date().toISOString() }) {
  const salvo = store.load()

  const sessions = salvo.sessions.map((s) => ({
    name: s.name,
    cwd: s.cwd,
    claudeSessionId: s.claudeSessionId ?? null,
    createdAt: s.createdAt ?? now(),
    lastActivityAt: s.lastActivityAt ?? now(),
    busy: false,
    queue: [],
    abort: null,
  }))

  let activeSession = sessions.some((s) => s.name === salvo.activeSession) ? salvo.activeSession : null

  function persist() {
    store.save({
      sessions: sessions.map((s) => Object.fromEntries(PERSISTIDO.map((k) => [k, s[k]]))),
      activeSession,
    })
  }

  function proximoNome() {
    for (let i = 1; ; i += 1) {
      const nome = `s${i}`
      if (!sessions.some((s) => s.name === nome)) return nome
    }
  }

  const api = {
    list: () => sessions,
    get: (name) => sessions.find((s) => s.name === name),
    active: () => sessions.find((s) => s.name === activeSession),

    create({ cwd, name } = {}) {
      const nome = name?.trim() || proximoNome()
      if (!NOME_VALIDO.test(nome)) {
        throw new Error(`nome inválido: use até 24 caracteres entre letras, números, - e _`)
      }
      if (api.get(nome)) throw new Error(`a sessão ${nome} já existe`)

      const sessao = {
        name: nome,
        cwd: expandir(cwd, defaultCwd),
        claudeSessionId: null,
        createdAt: now(),
        lastActivityAt: now(),
        busy: false,
        queue: [],
        abort: null,
      }
      sessions.push(sessao)
      activeSession = nome
      persist()
      return sessao
    },

    setActive(name) {
      if (!api.get(name)) return false
      activeSession = name
      persist()
      return true
    },

    end(name) {
      const i = sessions.findIndex((s) => s.name === name)
      if (i === -1) return false
      sessions[i].abort?.abort()
      sessions.splice(i, 1)
      if (activeSession === name) activeSession = sessions.at(-1)?.name ?? null
      persist()
      return true
    },

    touch(name) {
      const s = api.get(name)
      if (!s) return
      s.lastActivityAt = now()
      persist()
    },
  }

  return api
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 44 testes no total.

- [ ] **Step 5: Commit**

```bash
cd ~/claude-wpp
git add src/sessions.js test/sessions.test.js
git commit -m "Add session registry with persistence"
```

---

### Task 6: Execução do Claude

**Files:**
- Create: `src/claude.js`
- Test: `test/claude.test.js`
- Create: `test/fake-claude.sh` (executável)

**Interfaces:**
- Consumes: nada.
- Produces:
  `runClaude({ bin, cwd, prompt, sessionId, slowNoticeMs, timeoutMs, onSlow, signal }) -> Promise<{ ok, text, sessionId, error }>`.
  Nunca rejeita: erro vira `{ ok: false, error }`.

- [ ] **Step 1: Criar o `claude` falso**

Crie `test/fake-claude.sh` e torne-o executável (`chmod +x test/fake-claude.sh`).
Ele grava os argumentos recebidos em `$FAKE_ARGS_FILE` e se comporta conforme
`$FAKE_MODE`.

```bash
#!/usr/bin/env bash
if [ -n "$FAKE_ARGS_FILE" ]; then
  printf '%s\n' "$@" > "$FAKE_ARGS_FILE"
fi
case "$FAKE_MODE" in
  slow)
    sleep 0.4
    echo '{"result":"demorei","session_id":"sid-slow","is_error":false,"type":"result"}'
    ;;
  hang)
    sleep 30
    ;;
  garbage)
    echo 'isso nao e json'
    ;;
  claude_error)
    echo '{"result":"deu ruim","session_id":"sid-err","is_error":true,"type":"result"}'
    ;;
  crash)
    echo 'boom' >&2
    exit 3
    ;;
  *)
    echo '{"result":"pronto","session_id":"sid-ok","is_error":false,"type":"result"}'
    ;;
esac
```

- [ ] **Step 2: Escrever `test/claude.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runClaude } from '../src/claude.js'

const BIN = new URL('./fake-claude.sh', import.meta.url).pathname
const argsFile = () => join(mkdtempSync(join(tmpdir(), 'args-')), 'args.txt')

const base = { bin: BIN, cwd: tmpdir(), prompt: 'oi', slowNoticeMs: 50, timeoutMs: 5000 }

test('sessão nova não passa --resume e devolve o session_id', async () => {
  const file = argsFile()
  process.env.FAKE_ARGS_FILE = file
  process.env.FAKE_MODE = 'ok'
  const r = await runClaude({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'pronto')
  assert.equal(r.sessionId, 'sid-ok')

  const args = readFileSync(file, 'utf8').trim().split('\n')
  assert.deepEqual(args, ['-p', 'oi', '--output-format', 'json', '--dangerously-skip-permissions'])
})

test('sessão existente passa --resume com o id', async () => {
  const file = argsFile()
  process.env.FAKE_ARGS_FILE = file
  process.env.FAKE_MODE = 'ok'
  await runClaude({ ...base, sessionId: 'sid-antigo' })
  const args = readFileSync(file, 'utf8').trim().split('\n')
  assert.deepEqual(args.slice(-2), ['--resume', 'sid-antigo'])
})

test('dispara onSlow uma única vez quando demora', async () => {
  process.env.FAKE_MODE = 'slow'
  delete process.env.FAKE_ARGS_FILE
  let chamadas = 0
  const r = await runClaude({ ...base, onSlow: () => { chamadas += 1 } })
  assert.equal(chamadas, 1)
  assert.equal(r.ok, true)
})

test('não dispara onSlow quando responde rápido', async () => {
  process.env.FAKE_MODE = 'ok'
  let chamadas = 0
  await runClaude({ ...base, slowNoticeMs: 3000, onSlow: () => { chamadas += 1 } })
  assert.equal(chamadas, 0)
})

test('timeout mata o processo e devolve erro', async () => {
  process.env.FAKE_MODE = 'hang'
  const r = await runClaude({ ...base, timeoutMs: 150 })
  assert.equal(r.ok, false)
  assert.match(r.error, /tempo/i)
})

test('saída que não é json vira erro legível', async () => {
  process.env.FAKE_MODE = 'garbage'
  const r = await runClaude({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /resposta/i)
})

test('is_error do claude vira erro', async () => {
  process.env.FAKE_MODE = 'claude_error'
  const r = await runClaude({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /deu ruim/)
})

test('processo que morre com stderr vira erro com o stderr', async () => {
  process.env.FAKE_MODE = 'crash'
  const r = await runClaude({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
})

test('abort interrompe e devolve erro de cancelamento', async () => {
  process.env.FAKE_MODE = 'hang'
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 80)
  const r = await runClaude({ ...base, signal: ac.signal })
  assert.equal(r.ok, false)
  assert.match(r.error, /interrompid/i)
})

test('bin inexistente vira erro, não exceção', async () => {
  process.env.FAKE_MODE = 'ok'
  const r = await runClaude({ ...base, bin: '/nao/existe/claude' })
  assert.equal(r.ok, false)
  assert.ok(r.error.length > 0)
})
```

- [ ] **Step 3: Rodar e confirmar que falha**

Run: `cd ~/claude-wpp && npm test`
Expected: FAIL — `Cannot find module '../src/claude.js'`.

- [ ] **Step 4: Implementar `src/claude.js`**

```js
import { spawn } from 'node:child_process'

export function runClaude({
  bin = 'claude',
  cwd,
  prompt,
  sessionId = null,
  slowNoticeMs = 8000,
  timeoutMs = 900000,
  onSlow,
  signal,
} = {}) {
  return new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json', '--dangerously-skip-permissions']
    if (sessionId) args.push('--resume', sessionId)

    let finalizado = false
    let motivo = null
    let out = ''
    let err = ''

    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

    const encerrar = (resultado) => {
      if (finalizado) return
      finalizado = true
      clearTimeout(timerLento)
      clearTimeout(timerLimite)
      signal?.removeEventListener('abort', aoAbortar)
      resolve(resultado)
    }

    const timerLento = setTimeout(() => {
      if (!finalizado) onSlow?.()
    }, slowNoticeMs)

    const timerLimite = setTimeout(() => {
      motivo = 'timeout'
      child.kill('SIGKILL')
    }, timeoutMs)

    const aoAbortar = () => {
      motivo = 'abort'
      child.kill('SIGKILL')
    }
    signal?.addEventListener('abort', aoAbortar, { once: true })

    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })

    child.on('error', (e) => encerrar({ ok: false, text: '', sessionId, error: e.message }))

    child.on('close', (code) => {
      if (motivo === 'timeout') {
        return encerrar({ ok: false, text: '', sessionId, error: `Passei do tempo limite (${Math.round(timeoutMs / 1000)}s) e cancelei.` })
      }
      if (motivo === 'abort') {
        return encerrar({ ok: false, text: '', sessionId, error: 'Interrompido.' })
      }

      let json
      try {
        json = JSON.parse(out)
      } catch {
        const detalhe = (err || out).trim().slice(0, 500)
        return encerrar({ ok: false, text: '', sessionId, error: `Não entendi a resposta do claude (exit ${code}): ${detalhe || 'saída vazia'}` })
      }

      const novoId = json.session_id ?? sessionId
      if (json.is_error) {
        return encerrar({ ok: false, text: '', sessionId: novoId, error: String(json.result ?? 'erro sem descrição') })
      }
      encerrar({ ok: true, text: String(json.result ?? ''), sessionId: novoId, error: null })
    })
  })
}
```

- [ ] **Step 5: Rodar os testes e confirmar que passam**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 54 testes no total.

- [ ] **Step 6: Commit**

```bash
cd ~/claude-wpp
git add src/claude.js test/claude.test.js test/fake-claude.sh
git commit -m "Add claude CLI runner with resume, timeout and slow notice"
```

---

### Task 7: API HTTP

**Files:**
- Create: `src/api.js`
- Test: `test/api.test.js`

**Interfaces:**
- Consumes: nada (recebe `whatsapp` por injeção).
- Produces: `createApi({ host, port, token, whatsapp, sessionCount }) -> { listen(): Promise<number>, close(): Promise<void> }`.
  `whatsapp` precisa expor `sendText(numero, texto)` e `state()`.
  `sessionCount` é uma função que devolve um número.

- [ ] **Step 1: Escrever `test/api.test.js`**

```js
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApi } from '../src/api.js'

const enviados = []
const whatsapp = {
  sendText: async (to, text) => { enviados.push({ to, text }) },
  state: () => 'open',
}

let api
let base

before(async () => {
  api = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp, sessionCount: () => 2 })
  const porta = await api.listen()
  base = `http://127.0.0.1:${porta}`
})

after(async () => { await api.close() })

test('healthz não exige token', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, wa: 'open', sessions: 2 })
})

test('send sem token é 401', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi' }),
  })
  assert.equal(r.status, 401)
})

test('send com token errado é 401', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer errado' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi' }),
  })
  assert.equal(r.status, 401)
})

test('send válido entrega a mensagem', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi' }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true })
  assert.deepEqual(enviados.at(-1), { to: '5511911111111', text: 'oi' })
})

test('send sem campos obrigatórios é 400', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ to: '5511911111111' }),
  })
  assert.equal(r.status, 400)
})

test('send com json inválido é 400', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: '{ nao e json',
  })
  assert.equal(r.status, 400)
})

test('rota desconhecida é 404', async () => {
  const r = await fetch(`${base}/qualquer`)
  assert.equal(r.status, 404)
})

test('GET em /send é 405', async () => {
  const r = await fetch(`${base}/send`)
  assert.equal(r.status, 405)
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd ~/claude-wpp && npm test`
Expected: FAIL — `Cannot find module '../src/api.js'`.

- [ ] **Step 3: Implementar `src/api.js`**

```js
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'

const LIMITE_BODY = 64 * 1024

function tokenConfere(recebido, esperado) {
  const a = Buffer.from(String(recebido ?? ''))
  const b = Buffer.from(String(esperado))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function lerBody(req) {
  return new Promise((resolve, reject) => {
    let dados = ''
    req.on('data', (pedaco) => {
      dados += pedaco
      if (dados.length > LIMITE_BODY) {
        reject(new Error('body grande demais'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(dados))
    req.on('error', reject)
  })
}

export function createApi({ host, port, token, whatsapp, sessionCount = () => 0 }) {
  const json = (res, status, corpo) => {
    const texto = JSON.stringify(corpo)
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(texto) })
    res.end(texto)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'método não permitido' })
      return json(res, 200, { ok: true, wa: whatsapp.state(), sessions: sessionCount() })
    }

    if (url.pathname === '/send') {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'método não permitido' })

      const cabecalho = req.headers.authorization ?? ''
      if (!tokenConfere(cabecalho.replace(/^Bearer\s+/i, ''), token)) {
        return json(res, 401, { ok: false, error: 'não autorizado' })
      }

      let corpo
      try {
        corpo = JSON.parse(await lerBody(req))
      } catch {
        return json(res, 400, { ok: false, error: 'json inválido' })
      }

      const { to, text } = corpo ?? {}
      if (!to || !text) return json(res, 400, { ok: false, error: 'to e text são obrigatórios' })

      try {
        await whatsapp.sendText(String(to), String(text))
      } catch (err) {
        return json(res, 502, { ok: false, error: err.message })
      }
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { ok: false, error: 'não encontrado' })
  })

  return {
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve(server.address().port))
      })
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 62 testes no total.

- [ ] **Step 5: Commit**

```bash
cd ~/claude-wpp
git add src/api.js test/api.test.js
git commit -m "Add local HTTP API for sending WhatsApp messages"
```

---

### Task 8: Handler de mensagens

O cérebro do sistema, isolado de WhatsApp e de subprocessos para poder ser
testado com dublês.

**Files:**
- Create: `src/handler.js`
- Test: `test/handler.test.js`

**Interfaces:**
- Consumes: `parse` (Task 4), registry de sessões (Task 5), `runClaude` (Task 6).
- Produces: `createHandler({ sessions, run, reply, config }) -> handle(texto): Promise<void>`
  - `run({ cwd, prompt, sessionId, onSlow, signal })` tem a assinatura de retorno do `runClaude`.
  - `reply(texto)` envia uma string já pronta ao WhatsApp (sem prefixo — o handler prefixa).

- [ ] **Step 1: Escrever `test/handler.test.js`**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/store.js'
import { createSessions } from '../src/sessions.js'
import { createHandler } from '../src/handler.js'

function montar({ run } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'handler-'))
  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  const ditos = []
  const handler = createHandler({
    sessions,
    run: run ?? (async () => ({ ok: true, text: 'resposta', sessionId: 'sid-1', error: null })),
    reply: async (t) => { ditos.push(t) },
    config: { slowNoticeMs: 10, timeoutMs: 1000, maxMessageChars: 50, claudeBin: 'claude', defaultCwd: dir },
  })
  return { handler, sessions, ditos, dir }
}

test('mensagem sem sessão cria uma automaticamente', async () => {
  const { handler, sessions, ditos } = montar()
  await handler.handle('oi claude')
  assert.equal(sessions.list().length, 1)
  assert.equal(ditos.at(-1), '[s1] resposta')
})

test('grava o session_id devolvido pelo claude', async () => {
  const { handler, sessions } = montar()
  await handler.handle('oi')
  assert.equal(sessions.active().claudeSessionId, 'sid-1')
})

test('reenvia o session_id na mensagem seguinte', async () => {
  const vistos = []
  const { handler } = montar({
    run: async ({ sessionId }) => {
      vistos.push(sessionId)
      return { ok: true, text: 'ok', sessionId: 'sid-1', error: null }
    },
  })
  await handler.handle('primeira')
  await handler.handle('segunda')
  assert.deepEqual(vistos, [null, 'sid-1'])
})

test('/new cria sessão nomeada e confirma', async () => {
  const { handler, sessions, ditos, dir } = montar()
  await handler.handle(`/new ${dir} api`)
  assert.equal(sessions.active().name, 'api')
  assert.match(ditos.at(-1), /api/)
})

test('/new com nome duplicado responde o erro sem quebrar', async () => {
  const { handler, ditos, dir } = montar()
  await handler.handle(`/new ${dir} api`)
  await handler.handle(`/new ${dir} api`)
  assert.match(ditos.at(-1), /já existe/)
})

test('/ls lista as sessões marcando a ativa', async () => {
  const { handler, ditos, dir } = montar()
  await handler.handle(`/new ${dir} a`)
  await handler.handle(`/new ${dir} b`)
  await handler.handle('/ls')
  assert.match(ditos.at(-1), /a/)
  assert.match(ditos.at(-1), /b/)
  assert.match(ditos.at(-1), /\*/)
})

test('/use troca a ativa', async () => {
  const { handler, sessions, dir } = montar()
  await handler.handle(`/new ${dir} a`)
  await handler.handle(`/new ${dir} b`)
  await handler.handle('/use a')
  assert.equal(sessions.active().name, 'a')
})

test('/use com nome desconhecido avisa', async () => {
  const { handler, ditos } = montar()
  await handler.handle('/use fantasma')
  assert.match(ditos.at(-1), /fantasma/)
})

test('/end encerra a sessão', async () => {
  const { handler, sessions, dir } = montar()
  await handler.handle(`/new ${dir} a`)
  await handler.handle('/end a')
  assert.deepEqual(sessions.list(), [])
})

test('/help responde os comandos', async () => {
  const { handler, ditos } = montar()
  await handler.handle('/help')
  assert.match(ditos.at(-1), /\/new/)
  assert.match(ditos.at(-1), /@nome/)
})

test('comando desconhecido avisa e sugere /help', async () => {
  const { handler, ditos } = montar()
  await handler.handle('/inventado')
  assert.match(ditos.at(-1), /help/)
})

test('@nome roteia sem trocar a ativa', async () => {
  const { handler, sessions, ditos, dir } = montar()
  await handler.handle(`/new ${dir} a`)
  await handler.handle(`/new ${dir} b`)
  await handler.handle('@a faz isso')
  assert.equal(sessions.active().name, 'b')
  assert.equal(ditos.at(-1), '[a] resposta')
})

test('@nome desconhecido avisa', async () => {
  const { handler, ditos } = montar()
  await handler.handle('@fantasma oi')
  assert.match(ditos.at(-1), /fantasma/)
})

test('avisa "Trabalhando nisso." quando demora', async () => {
  const { handler, ditos } = montar({
    run: async ({ onSlow }) => {
      onSlow()
      return { ok: true, text: 'demorou', sessionId: 'sid-1', error: null }
    },
  })
  await handler.handle('tarefa longa')
  assert.equal(ditos[0], 'Trabalhando nisso.')
  assert.equal(ditos[1], '[s1] demorou')
})

test('resposta longa é quebrada em várias mensagens', async () => {
  const { handler, ditos } = montar({
    run: async () => ({ ok: true, text: 'x'.repeat(120), sessionId: 'sid-1', error: null }),
  })
  await handler.handle('gera texto grande')
  assert.ok(ditos.length > 1)
  for (const d of ditos) assert.ok(d.length <= 50 + '[s1] '.length)
})

test('erro do claude vira mensagem de erro prefixada', async () => {
  const { handler, ditos } = montar({
    run: async () => ({ ok: false, text: '', sessionId: null, error: 'deu ruim' }),
  })
  await handler.handle('quebra')
  assert.match(ditos.at(-1), /\[s1\]/)
  assert.match(ditos.at(-1), /deu ruim/)
})

test('mensagem que chega com a sessão ocupada é enfileirada e processada depois', async () => {
  let liberar
  const travado = new Promise((r) => { liberar = r })
  const processados = []
  const { handler } = montar({
    run: async ({ prompt }) => {
      processados.push(prompt)
      if (processados.length === 1) await travado
      return { ok: true, text: 'ok', sessionId: 'sid-1', error: null }
    },
  })

  const primeira = handler.handle('um')
  await new Promise((r) => setImmediate(r))
  const segunda = handler.handle('dois')
  liberar()
  await Promise.all([primeira, segunda])

  assert.deepEqual(processados, ['um', 'dois'])
})

test('sessões diferentes rodam em paralelo', async () => {
  let emVoo = 0
  let pico = 0
  const { handler, dir } = montar({
    run: async () => {
      emVoo += 1
      pico = Math.max(pico, emVoo)
      await new Promise((r) => setTimeout(r, 30))
      emVoo -= 1
      return { ok: true, text: 'ok', sessionId: 'sid-1', error: null }
    },
  })
  await handler.handle(`/new ${dir} a`)
  await handler.handle(`/new ${dir} b`)
  await Promise.all([handler.handle('@a x'), handler.handle('@b y')])
  assert.equal(pico, 2)
})

test('/stop sem nada rodando avisa', async () => {
  const { handler, ditos, dir } = montar()
  await handler.handle(`/new ${dir} a`)
  await handler.handle('/stop')
  assert.match(ditos.at(-1), /nada/i)
})
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `cd ~/claude-wpp && npm test`
Expected: FAIL — `Cannot find module '../src/handler.js'`.

- [ ] **Step 3: Implementar `src/handler.js`**

```js
import { parse } from './router.js'
import { chunkText } from './text.js'

const AJUDA = [
  'Comandos:',
  '/new [dir] [nome] — cria sessão e ativa',
  '/ls — lista as sessões',
  '/use <nome> — troca a sessão ativa',
  '/end [nome] — encerra (sem nome, encerra a ativa)',
  '/stop — interrompe o que a sessão ativa está fazendo',
  '/help — isto aqui',
  '@nome texto — manda pra outra sessão sem trocar a ativa',
].join('\n')

function ociosidade(iso) {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'agora'
  if (min < 60) return `${min}min`
  return `${Math.floor(min / 60)}h`
}

export function createHandler({ sessions, run, reply, config }) {
  async function responder(nome, texto) {
    for (const pedaco of chunkText(texto, config.maxMessageChars)) {
      await reply(`[${nome}] ${pedaco}`)
    }
  }

  async function executar(sessao, prompt) {
    sessao.busy = true
    sessao.abort = new AbortController()
    let avisou = false

    try {
      const r = await run({
        bin: config.claudeBin,
        cwd: sessao.cwd,
        prompt,
        sessionId: sessao.claudeSessionId,
        slowNoticeMs: config.slowNoticeMs,
        timeoutMs: config.timeoutMs,
        signal: sessao.abort.signal,
        onSlow: () => {
          if (avisou) return
          avisou = true
          reply('Trabalhando nisso.').catch(() => {})
        },
      })

      if (r.sessionId) sessao.claudeSessionId = r.sessionId
      sessions.touch(sessao.name)

      await responder(sessao.name, r.ok ? r.text : `Erro: ${r.error}`)
    } finally {
      sessao.busy = false
      sessao.abort = null
    }

    const proxima = sessao.queue.shift()
    if (proxima != null) await executar(sessao, proxima)
  }

  async function despachar(sessao, prompt) {
    if (sessao.busy) {
      sessao.queue.push(prompt)
      return
    }
    await executar(sessao, prompt)
  }

  const comandos = {
    async new(args) {
      const [dir, nome] = args
      try {
        const s = sessions.create({ cwd: dir, name: nome })
        await reply(`Sessão [${s.name}] criada em ${s.cwd}`)
      } catch (err) {
        await reply(`Não deu: ${err.message}`)
      }
    },

    async ls() {
      const lista = sessions.list()
      if (!lista.length) return reply('Nenhuma sessão aberta. Manda /new pra criar uma.')
      const ativa = sessions.active()?.name
      const linhas = lista.map((s) => {
        const marca = s.name === ativa ? '*' : ' '
        const estado = s.busy ? 'ocupada' : `ociosa ${ociosidade(s.lastActivityAt)}`
        return `${marca} ${s.name}  ${s.cwd}  (${estado})`
      })
      return reply(linhas.join('\n'))
    },

    async use(args) {
      const nome = args[0]
      if (!nome) return reply('Uso: /use <nome>')
      if (!sessions.setActive(nome)) return reply(`Não achei a sessão ${nome}.`)
      return reply(`Sessão ativa agora é [${nome}].`)
    },

    async end(args) {
      const nome = args[0] ?? sessions.active()?.name
      if (!nome) return reply('Não há sessão para encerrar.')
      if (!sessions.end(nome)) return reply(`Não achei a sessão ${nome}.`)
      const ativa = sessions.active()?.name
      return reply(`Sessão [${nome}] encerrada.${ativa ? ` Ativa agora: [${ativa}].` : ''}`)
    },

    async stop() {
      const s = sessions.active()
      if (!s?.busy) return reply('Não tem nada rodando agora.')
      s.queue.length = 0
      s.abort?.abort()
      return reply(`Interrompendo [${s.name}].`)
    },

    async help() {
      return reply(AJUDA)
    },
  }

  async function handle(texto) {
    const cmd = parse(texto)

    if (cmd.type === 'error') return reply(cmd.message)

    if (cmd.type === 'command') {
      const executor = comandos[cmd.name]
      if (!executor) return reply(`Não conheço /${cmd.name}. Manda /help.`)
      return executor(cmd.args)
    }

    let sessao
    if (cmd.target) {
      sessao = sessions.get(cmd.target)
      if (!sessao) return reply(`Não achei a sessão ${cmd.target}. Manda /ls.`)
    } else {
      sessao = sessions.active() ?? sessions.create({ cwd: config.defaultCwd })
    }

    return despachar(sessao, cmd.text)
  }

  return { handle }
}
```

- [ ] **Step 4: Rodar os testes e confirmar que passam**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 81 testes no total.

- [ ] **Step 5: Commit**

```bash
cd ~/claude-wpp
git add src/handler.js test/handler.test.js
git commit -m "Add message handler with commands, queueing and parallel sessions"
```

---

### Task 9: Adaptador do WhatsApp

Sem testes unitários: dublar o Baileys custaria mais do que entrega. A validação
é o pareamento manual da Task 10.

**Files:**
- Create: `src/whatsapp.js`

**Interfaces:**
- Consumes: `sameNumber`, `senderNumber` (Task 3).
- Produces: `createWhatsapp({ authDir, authorizedNumber, onMessage, log }) -> { connect(), sendText(numero, texto), state() }`.
  `onMessage(texto)` só é chamado para o número autorizado, fora de grupo e com
  `fromMe === false`.

- [ ] **Step 1: Implementar `src/whatsapp.js`**

```js
import { mkdirSync } from 'node:fs'
import qrcode from 'qrcode-terminal'
import * as baileys from '@whiskeysockets/baileys'
import { sameNumber, senderNumber, normalizeNumber } from './numbers.js'

const makeWASocket = baileys.makeWASocket ?? baileys.default
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys

// O Baileys espera um logger no formato do pino. Evitamos a dependência.
const loggerMudo = {
  level: 'silent',
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child() { return loggerMudo },
}

function textoDaMensagem(msg) {
  const m = msg.message
  if (!m) return ''
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    ''
  )
}

export function createWhatsapp({ authDir, authorizedNumber, onMessage, log = console }) {
  let sock = null
  let estado = 'closed'

  async function connect() {
    mkdirSync(authDir, { recursive: true })
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()

    estado = 'connecting'
    sock = makeWASocket({ version, auth: state, logger: loggerMudo, markOnlineOnConnect: false })

    sock.ev.on('creds.update', saveCreds)

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update

      if (qr) {
        log.info('Leia o QR abaixo com o WhatsApp do número do bot:')
        qrcode.generate(qr, { small: true })
      }

      if (connection === 'open') {
        estado = 'open'
        log.info('WhatsApp conectado.')
      }

      if (connection === 'close') {
        estado = 'closed'
        const motivo = lastDisconnect?.error?.output?.statusCode
        if (motivo === DisconnectReason.loggedOut) {
          log.error('Sessão do WhatsApp encerrada. Rode `npm run pair` para parear de novo.')
          return
        }
        log.warn(`WhatsApp caiu (${motivo}). Reconectando em 3s...`)
        setTimeout(() => { connect().catch((e) => log.error(e)) }, 3000)
      }
    })

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return
      for (const msg of messages) {
        try {
          if (msg.key?.fromMe) continue
          if (String(msg.key?.remoteJid ?? '').endsWith('@g.us')) continue

          const numero = senderNumber(msg.key)
          if (!sameNumber(numero, authorizedNumber)) {
            log.debug?.(`ignorado: remetente ${numero ?? 'desconhecido'}`)
            continue
          }

          const texto = textoDaMensagem(msg).trim()
          if (!texto) continue

          await onMessage(texto)
        } catch (err) {
          log.error(`falha ao tratar mensagem: ${err.stack ?? err.message}`)
        }
      }
    })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout conectando no WhatsApp')), 60000)
      const ouvir = ({ connection }) => {
        if (connection === 'open') {
          clearTimeout(timer)
          sock.ev.off('connection.update', ouvir)
          resolve()
        }
      }
      sock.ev.on('connection.update', ouvir)
    })
  }

  async function sendText(numero, texto) {
    if (!sock) throw new Error('WhatsApp não está conectado')
    const jid = `${normalizeNumber(numero)}@s.whatsapp.net`
    await sock.sendMessage(jid, { text: texto })
  }

  return { connect, sendText, state: () => estado }
}
```

- [ ] **Step 2: Conferir que o módulo carrega**

Run: `cd ~/claude-wpp && node -e "import('./src/whatsapp.js').then(m => console.log(Object.keys(m)))"`
Expected: `[ 'createWhatsapp' ]`. Se der erro de import do Baileys, ajuste a
resolução de `makeWASocket` para a versão instalada e rode de novo.

- [ ] **Step 3: Rodar a suíte inteira**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 81 testes (esta task não adiciona teste).

- [ ] **Step 4: Commit**

```bash
cd ~/claude-wpp
git add src/whatsapp.js
git commit -m "Add Baileys WhatsApp adapter with sender authorization"
```

---

### Task 10: Bootstrap, pareamento, systemd e README

**Files:**
- Create: `src/index.js`
- Create: `src/pair.js`
- Create: `systemd/claude-wpp.service`
- Create: `install.sh`
- Create: `README.md`

**Interfaces:**
- Consumes: todos os módulos anteriores.
- Produces: o executável do serviço.

- [ ] **Step 1: Implementar `src/index.js`**

```js
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { createStore } from './store.js'
import { createSessions } from './sessions.js'
import { createHandler } from './handler.js'
import { createWhatsapp } from './whatsapp.js'
import { createApi } from './api.js'
import { runClaude } from './claude.js'

const log = {
  info: (m) => console.log(`[info] ${m}`),
  warn: (m) => console.warn(`[warn] ${m}`),
  error: (m) => console.error(`[erro] ${m}`),
  debug: (m) => { if (process.env.CLAUDE_WPP_DEBUG) console.log(`[debug] ${m}`) },
}

const config = loadConfig()
const store = createStore(join(config.stateDir, 'state.json'))
const sessions = createSessions({ store, defaultCwd: config.defaultCwd })

const whatsapp = createWhatsapp({
  authDir: join(config.stateDir, 'wa-auth'),
  authorizedNumber: config.authorizedNumber,
  onMessage: (texto) => handler.handle(texto).catch((e) => log.error(e.stack ?? e.message)),
  log,
})

const handler = createHandler({
  sessions,
  run: runClaude,
  reply: (texto) => whatsapp.sendText(config.authorizedNumber, texto),
  config,
})

const api = createApi({
  host: config.apiHost,
  port: config.apiPort,
  token: config.apiToken,
  whatsapp,
  sessionCount: () => sessions.list().length,
})

async function main() {
  await whatsapp.connect()
  const porta = await api.listen()
  log.info(`API ouvindo em http://${config.apiHost}:${porta}`)
  log.info(`${sessions.list().length} sessão(ões) recuperada(s) do estado.`)
}

for (const sinal of ['SIGINT', 'SIGTERM']) {
  process.on(sinal, async () => {
    log.info(`recebi ${sinal}, encerrando`)
    await api.close().catch(() => {})
    process.exit(0)
  })
}

main().catch((err) => {
  log.error(err.stack ?? err.message)
  process.exit(1)
})
```

- [ ] **Step 2: Implementar `src/pair.js`**

Sobe só a parte do WhatsApp, imprime o QR e sai quando conectar.

```js
import { join } from 'node:path'
import { loadConfig } from './config.js'
import { createWhatsapp } from './whatsapp.js'

const config = loadConfig()

const whatsapp = createWhatsapp({
  authDir: join(config.stateDir, 'wa-auth'),
  authorizedNumber: config.authorizedNumber,
  onMessage: async () => {},
  log: console,
})

console.log(`Pareando o número do bot (${config.botNumber}).`)
console.log('No celular: WhatsApp > Aparelhos conectados > Conectar aparelho.')

await whatsapp.connect()
console.log('Pareado. As credenciais ficaram em', join(config.stateDir, 'wa-auth'))
console.log('Agora suba o serviço: systemctl --user start claude-wpp')
process.exit(0)
```

- [ ] **Step 3: Criar `systemd/claude-wpp.service`**

```ini
[Unit]
Description=claude-wpp — Claude Code via WhatsApp
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/home/user/claude-wpp
Environment=PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin
Environment=HOME=/home/user
Environment=NODE_ENV=production
ExecStart=/home/user/.asdf/installs/nodejs/24.15.0/bin/node /home/user/claude-wpp/src/index.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

- [ ] **Step 4: Criar `install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIDADE="$HOME/.config/systemd/user/claude-wpp.service"

if [ ! -f "$RAIZ/config.json" ]; then
  echo "Falta o config.json. Copie o config.example.json e ponha o seu token." >&2
  exit 1
fi

mkdir -p "$(dirname "$UNIDADE")"
cp "$RAIZ/systemd/claude-wpp.service" "$UNIDADE"
systemctl --user daemon-reload
systemctl --user enable claude-wpp.service

echo
echo "Unidade instalada em $UNIDADE"
echo
echo "Falta você rodar, uma vez só, com sudo:"
echo "  sudo loginctl enable-linger $USER"
echo
echo "Sem isso o serviço morre quando você desloga e não sobe no boot."
echo
echo "Depois: npm run pair  (leia o QR) e  systemctl --user start claude-wpp"
```

Run: `chmod +x install.sh`

- [ ] **Step 5: Criar o `README.md`**

````markdown
# claude-wpp

Claude Code pelo WhatsApp, com várias sessões paralelas, usando a subscription
já autenticada neste host.

## Instalação

```bash
cd ~/claude-wpp
npm install
cp config.example.json config.json   # ponha o seu apiToken
./install.sh
sudo loginctl enable-linger "$USER"  # uma vez só
npm run pair                          # leia o QR com o número do bot
systemctl --user start claude-wpp
```

## Uso no WhatsApp

| Comando | Efeito |
|---|---|
| `/new [dir] [nome]` | cria a sessão e ativa |
| `/ls` | lista as sessões |
| `/use <nome>` | troca a sessão ativa |
| `/end [nome]` | encerra a sessão |
| `/stop` | interrompe o que a ativa está fazendo |
| `/help` | lista os comandos |
| `@nome texto` | manda pra outra sessão sem trocar a ativa |
| texto solto | vai pra sessão ativa |

Quando algo demora mais de 8 segundos, o bot responde `Trabalhando nisso.` uma
vez e depois manda o resultado.

## API local

```bash
curl -X POST localhost:8787/send \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"to":"5511911111111","text":"oi"}'

curl localhost:8787/healthz
```

## Operação

```bash
systemctl --user status claude-wpp
journalctl --user -u claude-wpp -f
systemctl --user restart claude-wpp
```

O estado fica em `~/.local/state/claude-wpp/`. O histórico das conversas
pertence ao Claude Code, em `~/.claude/projects/` — reiniciar o serviço não
perde nenhuma sessão.

## Aviso

O serviço roda o Claude com `--dangerously-skip-permissions` e diretório livre.
Quem tiver o WhatsApp autorizado executa comandos nesta máquina como o seu
usuário. Só o número configurado em `authorizedNumber` é atendido.
````

- [ ] **Step 6: Rodar a suíte inteira**

Run: `cd ~/claude-wpp && npm test`
Expected: PASS — 81 testes.

- [ ] **Step 7: Verificar que o bootstrap carrega sem config**

Run: `cd ~/claude-wpp && node src/index.js 2>&1 | head -3`
Expected: erro claro citando `config.json` (o arquivo real ainda não existe).
Isso confirma que a validação de config funciona antes de qualquer I/O.

- [ ] **Step 8: Commit**

```bash
cd ~/claude-wpp
git add src/index.js src/pair.js systemd/claude-wpp.service install.sh README.md
git commit -m "Add service bootstrap, pairing script, systemd unit and docs"
```

---

## Entrega manual (fora do plano automatizável)

Estes passos exigem o João presente e não podem ser executados por um agente:

1. `cp config.example.json config.json` e preencher o `apiToken` com o token que
   a skill `send-whatsapp` já usa.
2. `sudo loginctl enable-linger $USER` — pede senha.
3. `npm run pair` e ler o QR com o aparelho **+55 11 92222-2222**.
4. `systemctl --user start claude-wpp` e mandar um `oi` do **+55 11 91111-1111`**
   para confirmar ponta a ponta.
5. `/send-whatsapp` para confirmar que a skill voltou a funcionar.
