# claude-wpp — Claude Code via WhatsApp

**Data:** 2026-08-22
**Status:** aprovado, pronto para plano de implementação

## Problema

Conversar com o Claude Code pelo WhatsApp, a partir do celular, mantendo várias
conversas independentes e reaproveitando a subscription já autenticada neste
host — sem consumir a API paga.

## Decisões

| Decisão | Escolha | Motivo |
|---|---|---|
| Linguagem | Node 24 (ESM) | Já instalado; Baileys é a melhor biblioteca de WhatsApp e é Node |
| Biblioteca WhatsApp | `@whiskeysockets/baileys` | WebSocket puro, sem Chromium; ~80MB de RAM contra ~500MB do `whatsapp-web.js`, que ainda quebra quando o DOM do WhatsApp Web muda |
| Driver do Claude | `claude -p` one-shot + `--resume <session_id>` | Estado vive em `~/.claude/projects/`, então o daemon é descartável; paralelismo sai de graça |
| Permissões | `--dangerously-skip-permissions`, cwd livre | Não há como aprovar prompt de permissão pelo WhatsApp |
| Roteamento | Sessão ativa + prefixo `@nome` | Mensagem solta vai pra ativa; `@nome` desvia sem trocar |
| Feedback | `"Trabalhando nisso."` após 8s, depois só a resposta final | Chat limpo |
| API HTTP | `POST /send` + `GET /healthz` | Contrato idêntico ao que a skill `send-whatsapp` já consome |
| Persistência | JSON em `~/.local/state/claude-wpp/` | Não há dado relacional; banco seria peso morto |

### Verificações feitas antes de decidir

O driver do Claude foi validado empiricamente neste host, não assumido:

1. `claude -p '…' --output-format json` devolve `session_id` no JSON.
2. `claude -p --resume <id> '…'` em **processo novo** recupera o contexto da
   conversa anterior, e o `session_id` se mantém estável entre retomadas.
3. Dois `claude -p --dangerously-skip-permissions` simultâneos executam
   ferramentas de verdade, em paralelo, com zero `permission_denials`.

## Arquitetura

Processo Node único. Módulos pequenos, uma responsabilidade cada.

```
~/claude-wpp/
├── src/index.js      bootstrap, wiring, shutdown limpo
├── src/config.js     config.json + env, validado no boot
├── src/whatsapp.js   Baileys: conexão, QR, reconexão, sendText, onMessage
├── src/router.js     parser de comandos (/new, @nome, texto solto)
├── src/sessions.js   registry: criar, listar, trocar, encerrar, fila
├── src/claude.js     spawn do `claude -p`, parse JSON, timeout, aviso de demora
├── src/api.js        HTTP: POST /send, GET /healthz
└── src/store.js      persistência em ~/.local/state/claude-wpp/state.json
```

Fluxo de entrada: `whatsapp` → `router` → `sessions` → `claude` → `whatsapp`.
A API HTTP entra direto em `whatsapp.sendText`, sem passar pelo Claude.

### Interfaces entre módulos

- `whatsapp`: `connect()`, `sendText(jid, text)`, `on('message', ({from, text}))`,
  `state()` → `"open" | "connecting" | "closed"`.
- `sessions`: `create({cwd, name})`, `list()`, `get(name)`, `setActive(name)`,
  `end(name)`, `enqueue(name, text)`. Nada de I/O de rede aqui.
- `claude`: `run({cwd, claudeSessionId, prompt, onSlow})` →
  `{ result, sessionId, isError }`. Não conhece WhatsApp.
- `store`: `load()`, `save(state)`. Só serialização.

`router` e `sessions` são funções puras sobre estado; é onde mora a maior parte
dos testes.

## Sessões

```js
{
  name: "api",                       // slug único
  claudeSessionId: "a7b4ceaf-…",     // null até a primeira resposta
  cwd: "/home/user/work/api",
  createdAt, lastActivityAt,
  busy: false,
  queue: []                          // mensagens chegadas durante execução
}
```

Estado global: `{ sessions: [...], activeSession: "api" }`, salvo a cada mutação.

Em disco fica apenas o ponteiro `claudeSessionId` — o histórico real pertence ao
Claude Code, em `~/.claude/projects/`. Consequência: o daemon pode cair,
reiniciar ou ser atualizado sem perder nenhuma conversa.

Uma sessão ocupada enfileira as mensagens seguintes e as processa em ordem — não
é possível retomar a mesma sessão em dois processos ao mesmo tempo. Sessões
distintas rodam de fato em paralelo.

### Comandos

| Comando | Efeito |
|---|---|
| `/new [dir] [nome]` | Cria e ativa. `dir` default `~`, nome auto (`s1`, `s2`…) |
| `/ls` | Lista: nome, cwd, qual é a ativa, ociosidade, se está ocupada |
| `/use <nome>` | Troca a sessão ativa |
| `/end [nome]` | Encerra (esquece o ponteiro); sem nome, encerra a ativa |
| `/stop` | Mata o processo em execução da sessão ativa |
| `/help` | Lista os comandos |
| `@nome texto` | Envia para `nome` sem trocar a ativa |
| *texto solto* | Vai para a sessão ativa; cria uma se não houver nenhuma |

Toda resposta é prefixada com `[nome]`. Com sessões paralelas as respostas
chegam fora de ordem, e o prefixo é o que identifica a origem.

`/end` esquece o ponteiro mas não apaga nada em `~/.claude/projects/` — a
operação é barata e reversível.

## Execução do Claude

```
spawn('claude', [
  '-p', texto,
  '--output-format', 'json',
  '--dangerously-skip-permissions',
  ...(claudeSessionId ? ['--resume', claudeSessionId] : [])
], { cwd })
```

- Sem `session_id` ainda, omite `--resume` e grava o id que voltar no JSON.
- **8 segundos** sem terminar dispara `"Trabalhando nisso."`, uma única vez por
  mensagem.
- Timeout duro de **15 minutos**: mata o processo e responde o erro.
- Resposta acima de ~3.500 caracteres é quebrada em várias mensagens, cortando
  em quebras de linha.
- `is_error: true` ou JSON inválido no stdout viram uma mensagem de erro legível,
  com o stderr truncado.

## WhatsApp

Baileys com `useMultiFileAuthState` em `~/.local/state/claude-wpp/wa-auth`.

Pareamento uma única vez: `npm run pair` em foreground imprime o QR no terminal,
lido pelo aparelho **+55 11 92222-2222**. As credenciais ficam salvas e o daemon
passa a subir sozinho.

Reconexão automática em queda de conexão. A única condição que para o serviço de
vez é `DisconnectReason.loggedOut` — aí é preciso parear de novo.

### Autorização

O serviço responde **exclusivamente** ao número **+55 11 91111-1111**.

Grupos, mensagens próprias (`fromMe`) e qualquer outro remetente são descartados
em silêncio: log em nível debug, nenhuma resposta. Não confirmar a existência do
serviço para um remetente não autorizado é deliberado.

A comparação de números normaliza o JID antes de comparar — reduz a apenas
dígitos e tolera o nono dígito de celular brasileiro, além do formato `@lid` que
versões recentes do Baileys entregam no lugar de `@s.whatsapp.net`.

## API HTTP

`node:http` puro, sem framework, ouvindo em `127.0.0.1:8787`.

```
POST /send
  authorization: Bearer <token>
  { "to": "5511911111111", "text": "…" }
  → 200 { "ok": true }

GET /healthz
  → 200 { "ok": true, "wa": "open", "sessions": 2 }
```

O token é o mesmo já usado pela skill `send-whatsapp`, que volta a funcionar sem
alteração. `/healthz` não exige token; `/send` exige.

## systemd

`~/.config/systemd/user/claude-wpp.service`, com `Restart=always` e
`RestartSec=5`.

Caminhos absolutos, resolvidos na instalação — o ambiente do systemd não tem os
shims do asdf:

- node: `/home/user/.asdf/installs/nodejs/24.15.0/bin/node`
- claude: `/home/user/.local/bin/claude` (symlink estável; a versão por baixo
  muda a cada atualização). O `PATH` do serviço inclui `~/.local/bin`.

Requer **`sudo loginctl enable-linger $USER`**. Sem linger, o serviço morre no
logout e não sobe no boot. É o único comando com sudo do projeto.

## Testes

TDD em `sessions`, `router` e `store` com `node:test`: parser de comandos, ciclo
de vida da sessão, fila de mensagens, persistência e recuperação de estado.

`claude.js` é testado contra um executável `claude` falso, injetado no `PATH` do
teste, que ecoa um JSON controlado. Verifica as flags montadas, a presença e a
ausência de `--resume`, o comportamento de timeout e o disparo do
`"Trabalhando nisso."`.

`whatsapp.js` e `api.js` ficam em smoke manual. Mockar o Baileys custa mais do
que o teste entregaria.

## Fora de escopo

Múltiplos números autorizados, multi-usuário, streaming de progresso por
ferramenta, interface web, banco de dados, Docker.

## Risco aceito

Bypass de permissão com diretório livre significa que qualquer mensagem vinda do
número autorizado executa comandos reais nesta máquina, com o usuário do serviço e
sem confirmação. Quem controlar aquele WhatsApp tem shell aqui.

A decisão foi tomada de forma consciente pelo dono do host. As mitigações que
existem: um único número autorizado, API presa a `127.0.0.1`, e nada de
resposta a remetente desconhecido.
