import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createStore } from '../src/store.js'
import { createSessions } from '../src/sessions.js'
import { createHandler } from '../src/handler.js'
import { transcribe as transcribeReal } from '../src/transcribe.js'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'
import { createRelay } from '../src/relay.js'

// A real relay over a real db, with the two outside calls faked.
async function relayComResposta() {
  const enviados = []
  const relay = createRelay({
    db: openDb(':memory:'),
    ownerNumber: '5511999999999',
    notifyOwner: async () => 'OWNER-1',
    sendAsBot: async (jid, texto) => { enviados.push({ jid, texto }) },
    formalize: async () => 'Olá. Confirmado para amanhã.',
    log: {},
  })
  relay.noteSent('5511911111111')
  await relay.onOther({ key: { remoteJid: '5511911111111@s.whatsapp.net' }, kind: 'text', text: 'amanhã?' })
  return { relay, enviados }
}

const citando = (stanzaId) => ({ message: { extendedTextMessage: { text: 'x', contextInfo: { stanzaId } } } })

function montar({ run, attach, transcribe, config, listAgents, replyFile, relay, classify } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'handler-'))
  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  const ditos = []
  const handler = createHandler({
    sessions,
    classify,
    run: run ?? (async () => ({ ok: true, text: 'resposta', sessionId: 'sid-1', error: null })),
    attach,
    transcribe: transcribe ?? (async () => ({ ok: true, text: 'transcrição do áudio', error: null })),
    reply: async (t) => { ditos.push(t) },
    replyFile,
    listAgents,
    relay,
    config: {
      slowNoticeMs: 10,
      timeoutMs: 1000,
      maxMessageChars: 50,
      claudeBin: 'claude',
      defaultCwd: dir,
      openaiApiKey: 'sk-teste',
      transcribeModel: 'gpt-4o-transcribe',
      transcribeTimeoutMs: 1000,
      ...config,
    },
  })
  return { handler, sessions, ditos, dir }
}

function arquivoFalso(dir, nome) {
  const caminho = join(dir, nome)
  writeFileSync(caminho, 'bytes')
  return caminho
}

test('mensagem sem sessão cria uma automaticamente', async () => {
  const { handler, sessions, ditos } = montar()
  await handler.handle('oi claude')
  assert.equal(sessions.list().length, 1)
  assert.equal(ditos.at(-1), '[s1] resposta')
})

test('toda mensagem leva a instrução de formatar pro whatsapp', async () => {
  const vistos = []
  const { handler } = montar({
    run: async ({ appendSystemPrompt }) => {
      vistos.push(appendSystemPrompt)
      return { ok: true, text: 'ok', sessionId: 'sid-1', error: null }
    },
  })
  await handler.handle('oi')
  assert.match(vistos[0], /whatsapp/i)
})

test('grava o session_id devolvido pelo claude', async () => {
  const { handler, sessions } = montar()
  await handler.handle('oi')
  assert.equal(sessions.active().claudeSessionId, 'sid-1')
})

// claude.js manda sessionBroken quando prova que o id que tentou --resume
// está morto (claude devolveu state: failed) — guardar esse id de novo
// faria toda mensagem seguinte repetir a mesma falha para sempre.
test('sessionBroken limpa o session_id guardado em vez de gravar o morto de novo', async () => {
  const { handler, sessions } = montar({
    run: async () => ({ ok: false, text: '', sessionId: 'sid-morto', sessionBroken: true, error: 'a sessão falhou no claude (state: failed)' }),
  })
  await handler.handle('oi')
  assert.equal(sessions.active().claudeSessionId, null)
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

test('/manuais lista sessões do host que o bot não conhece', async () => {
  const { handler, ditos, dir } = montar({
    listAgents: async () => [
      { sessionId: 'sid-manual', name: 'caws', cwd: dir, status: 'idle', kind: 'interactive' },
      { sessionId: 'sid-bg', name: 'algo', cwd: dir, status: 'busy', kind: 'background' },
    ],
  })
  await handler.handle('/manuais')
  assert.match(ditos.at(-1), /1\. caws/)
  assert.match(ditos.at(-1), /interativa/)
  assert.match(ditos.at(-1), /2\. algo/)
  assert.match(ditos.at(-1), /background/)
})

test('/manuais avisa quando uma sessão já saiu de vez (state done, sem status)', async () => {
  const { handler, ditos, dir } = montar({
    listAgents: async () => [{ sessionId: 'sid-morta', name: 'caws', cwd: dir, state: 'done', kind: 'background' }],
  })
  await handler.handle('/manuais')
  assert.match(ditos.at(-1), /done/)
  assert.match(ditos.at(-1), /pode travar/)
})

test('/manuais não repete uma sessão que o bot já rastreia', async () => {
  const { handler, sessions, ditos, dir } = montar({
    run: async () => ({ ok: true, text: 'ok', sessionId: 'sid-do-bot', error: null }),
    listAgents: async () => [
      { sessionId: 'sid-do-bot', name: 's1', cwd: dir, status: 'idle', kind: 'background' },
      { sessionId: 'sid-fora', name: 'outra', cwd: dir, status: 'idle', kind: 'interactive' },
    ],
  })
  await handler.handle('oi')
  assert.equal(sessions.active().claudeSessionId, 'sid-do-bot')
  await handler.handle('/manuais')
  assert.doesNotMatch(ditos.at(-1), /s1/)
  assert.match(ditos.at(-1), /outra/)
})

test('/manuais sem nenhuma sessão fora do bot avisa em vez de mandar lista vazia', async () => {
  const { handler, ditos } = montar({ listAgents: async () => [] })
  await handler.handle('/manuais')
  assert.match(ditos.at(-1), /nenhuma sessão/i)
})

test('/manuais sem suporte a listAgents explica em vez de quebrar', async () => {
  const { handler, ditos } = montar({ listAgents: null })
  await handler.handle('/manuais')
  assert.match(ditos.at(-1), /não consigo/i)
})

test('/importar registra a sessão da lista e ativa', async () => {
  const { handler, sessions, ditos, dir } = montar({
    listAgents: async () => [{ sessionId: 'sid-manual', name: 'caws', cwd: dir, status: 'idle', kind: 'interactive' }],
  })
  await handler.handle('/manuais')
  await handler.handle('/importar 1 caws')
  assert.equal(sessions.get('caws').claudeSessionId, 'sid-manual')
  assert.equal(sessions.active().name, 'caws')
  assert.match(ditos.at(-1), /importada/)
})

test('/importar sem nome mantém o nome que a sessão já tinha', async () => {
  const { handler, sessions, dir } = montar({
    listAgents: async () => [{ sessionId: 'sid-manual', name: 'caws', cwd: dir, status: 'idle', kind: 'interactive' }],
  })
  await handler.handle('/manuais')
  await handler.handle('/importar 1')
  assert.equal(sessions.get('caws').claudeSessionId, 'sid-manual')
})

test('/importar sem nome sanitiza um nome de sessão que não seria válido como está', async () => {
  const { handler, sessions, dir } = montar({
    listAgents: async () => [{ sessionId: 'sid-manual', name: 'claude-wpp agent migration!', cwd: dir, status: 'idle', kind: 'background' }],
  })
  await handler.handle('/manuais')
  await handler.handle('/importar 1')
  assert.equal(sessions.get('claude-wpp-agent-migrati')?.claudeSessionId, 'sid-manual')
})

test('/importar sem nome e sem nome aproveitável cai no automático, igual /new', async () => {
  const { handler, sessions, dir } = montar({
    listAgents: async () => [{ sessionId: 'sid-manual', name: null, cwd: dir, status: 'idle', kind: 'background' }],
  })
  await handler.handle('/manuais')
  await handler.handle('/importar 1')
  assert.equal(sessions.get('s1').claudeSessionId, 'sid-manual')
})

test('/importar com número que não existe explica em vez de quebrar', async () => {
  const { handler, ditos, dir } = montar({
    listAgents: async () => [{ sessionId: 'sid-manual', name: 'caws', cwd: dir, status: 'idle', kind: 'interactive' }],
  })
  await handler.handle('/manuais')
  await handler.handle('/importar 9')
  assert.match(ditos.at(-1), /não achei/i)
})

test('/importar sem /manuais antes explica em vez de quebrar', async () => {
  const { handler, ditos } = montar()
  await handler.handle('/importar 1')
  assert.match(ditos.at(-1), /não achei/i)
})

test('/importar com nome que já existe devolve o erro do sessions.create', async () => {
  const { handler, ditos, dir } = montar({
    listAgents: async () => [{ sessionId: 'sid-manual', name: 'caws', cwd: dir, status: 'idle', kind: 'interactive' }],
  })
  await handler.handle(`/new ${dir} caws`)
  await handler.handle('/manuais')
  await handler.handle('/importar 1 caws')
  assert.match(ditos.at(-1), /já existe/)
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

test('/cd muda a pasta da sessão ativa, a partir da pasta atual, e zera a conversa', async () => {
  const { handler, sessions, ditos, dir } = montar()
  mkdirSync(join(dir, 'sub dir'))
  await handler.handle(`/new ${dir} api`)
  sessions.get('api').claudeSessionId = 'sid-antigo'

  await handler.handle('/cd sub dir')
  const s = sessions.get('api')
  assert.equal(s.cwd, join(dir, 'sub dir'), 'caminho relativo resolve a partir da pasta da sessão, com espaço')
  assert.equal(s.claudeSessionId, null, 'o histórico do Claude é por pasta: a conversa recomeça')
  assert.match(ditos.at(-1), /recomeça/)

  await handler.handle('/cd ..')
  assert.equal(sessions.get('api').cwd, dir)
})

test('/cd para a mesma pasta não joga a conversa fora', async () => {
  const { handler, sessions, ditos, dir } = montar()
  await handler.handle(`/new ${dir} api`)
  sessions.get('api').claudeSessionId = 'sid-1'
  await handler.handle('/cd .')
  assert.equal(sessions.get('api').claudeSessionId, 'sid-1')
  assert.match(ditos.at(-1), /já está/)
})

test('/cd para pasta que não existe explica e não mexe na sessão', async () => {
  const { handler, sessions, ditos, dir } = montar()
  await handler.handle(`/new ${dir} api`)
  await handler.handle('/cd nao-existe')
  assert.equal(sessions.get('api').cwd, dir)
  assert.match(ditos.at(-1), /não existe/)
})

test('/cd recusa enquanto a sessão está rodando', async () => {
  let liberar
  const espera = new Promise((r) => { liberar = r })
  const { handler, sessions, ditos, dir } = montar({
    run: async () => { await espera; return { ok: true, text: 'ok', sessionId: 'sid-1', error: null } },
    config: { slowNoticeMs: 10_000 },
  })
  mkdirSync(join(dir, 'outra'))
  await handler.handle(`/new ${dir} api`)
  const turno = handler.handle('trabalha')
  await new Promise((r) => setImmediate(r))

  await handler.handle('/cd outra')
  assert.equal(sessions.get('api').cwd, dir)
  assert.match(ditos.at(-1), /rodando/)
  liberar()
  await turno
})

test('/cd recusa com pedido interrompido pendente', async () => {
  const { handler, sessions, ditos, dir } = montar()
  mkdirSync(join(dir, 'outra'))
  await handler.handle(`/new ${dir} api`)
  sessions.beginRun('api', 'pedido que morreu')
  await handler.handle('/cd outra')
  assert.equal(sessions.get('api').cwd, dir)
  assert.match(ditos.at(-1), /\/retomar/)
})

test('/cd sem argumento mostra o uso', async () => {
  const { handler, ditos, dir } = montar()
  await handler.handle(`/new ${dir} api`)
  await handler.handle('/cd')
  assert.match(ditos.at(-1), /Uso: \/cd/)
})

test('/end encerra a sessão', async () => {
  const { handler, sessions, dir } = montar()
  await handler.handle(`/new ${dir} a`)
  await handler.handle('/end a')
  assert.deepEqual(sessions.list(), [])
})

test('/end avisa quantas mensagens da fila foram descartadas', async () => {
  let liberar
  const espera = new Promise((r) => { liberar = r })
  const { handler, sessions, ditos, dir } = montar({
    run: async () => { await espera; return { ok: true, text: 'ok', sessionId: 'sid-1', error: null } },
  })
  await handler.handle(`/new ${dir} a`)
  const emAndamento = handler.handle('primeira') // ocupa a sessão
  await handler.handle('segunda') // vai pra fila
  await handler.handle('terceira') // vai pra fila também
  await handler.handle('/end a')
  assert.match(ditos.at(-1), /2 mensagens na fila foram descartadas/)
  liberar()
  await emAndamento
  assert.equal(sessions.get('a'), undefined)
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

test('mensagem em objeto sem mídia se comporta como texto puro', async () => {
  const prompts = []
  const { handler } = montar({
    run: async ({ prompt }) => {
      prompts.push(prompt)
      return { ok: true, text: 'ok', sessionId: 'sid-1', error: null }
    },
  })
  await handler.handle({ text: 'oi claude', media: null })
  assert.deepEqual(prompts, ['oi claude'])
})

test('imagem com legenda manda a legenda e o caminho para o claude', async () => {
  const prompts = []
  const { handler, dir } = montar({
    run: async ({ prompt }) => {
      prompts.push(prompt)
      return { ok: true, text: 'ok', sessionId: 'sid-1', error: null }
    },
  })
  const caminho = arquivoFalso(dir, 'foto.jpg')

  await handler.handle({ text: 'que erro é esse?', media: { kind: 'image', path: caminho } })

  assert.match(prompts[0], /que erro é esse\?/)
  assert.ok(prompts[0].includes(caminho))
})

test('imagem sem legenda ainda chega ao claude com um pedido padrão', async () => {
  const prompts = []
  const { handler, dir } = montar({
    run: async ({ prompt }) => {
      prompts.push(prompt)
      return { ok: true, text: 'ok', sessionId: 'sid-1', error: null }
    },
  })
  const caminho = arquivoFalso(dir, 'foto.jpg')

  await handler.handle({ text: '', media: { kind: 'image', path: caminho } })

  assert.equal(prompts.length, 1)
  assert.ok(prompts[0].includes(caminho))
})

test('imagem com legenda @sessao roteia para a sessão indicada', async () => {
  const { handler, sessions, ditos, dir } = montar()
  await handler.handle(`/new ${dir} a`)
  await handler.handle(`/new ${dir} b`)

  await handler.handle({ text: '@a olha isso', media: { kind: 'image', path: arquivoFalso(dir, 'foto.jpg') } })

  assert.equal(sessions.active().name, 'b')
  assert.equal(ditos.at(-1), '[a] resposta')
})

test('imagem é preservada em disco para o claude poder ler', async () => {
  const { handler, dir } = montar()
  const caminho = arquivoFalso(dir, 'foto.jpg')

  await handler.handle({ text: 'olha', media: { kind: 'image', path: caminho } })

  assert.ok(existsSync(caminho))
})

test('imagem colada num comando não atrapalha o comando', async () => {
  const { handler, ditos, dir } = montar()

  await handler.handle({ text: '/help', media: { kind: 'image', path: arquivoFalso(dir, 'foto.jpg') } })

  assert.match(ditos.at(-1), /\/new/)
})

test('áudio é transcrito e a transcrição vira o prompt', async () => {
  const prompts = []
  const { handler, dir, ditos } = montar({
    run: async ({ prompt }) => {
      prompts.push(prompt)
      return { ok: true, text: 'ok', sessionId: 'sid-1', error: null }
    },
    transcribe: async () => ({ ok: true, text: 'roda os testes', error: null }),
  })

  await handler.handle({ text: '', media: { kind: 'audio', path: arquivoFalso(dir, 'audio.ogg') } })

  assert.deepEqual(prompts, ['roda os testes'])
  assert.equal(ditos.at(-1), '[s1] ok')
})

test('áudio recebe a chave e o modelo vindos do config', async () => {
  let visto = null
  const { handler, dir } = montar({
    transcribe: async (opts) => {
      visto = opts
      return { ok: true, text: 'oi', error: null }
    },
    config: { openaiApiKey: 'sk-do-config', transcribeModel: 'whisper-1', transcribeTimeoutMs: 4321 },
  })
  const caminho = arquivoFalso(dir, 'audio.ogg')

  await handler.handle({ text: '', media: { kind: 'audio', path: caminho } })

  assert.equal(visto.path, caminho)
  assert.equal(visto.apiKey, 'sk-do-config')
  assert.equal(visto.model, 'whisper-1')
  assert.equal(visto.timeoutMs, 4321)
})

test('áudio transcrito como comando é executado como comando', async () => {
  const { handler, ditos } = montar({
    transcribe: async () => ({ ok: true, text: '/help', error: null }),
  })

  await handler.handle({ text: '', media: { kind: 'audio', path: arquivoFalso(montar().dir, 'audio.ogg') } })

  assert.match(ditos.at(-1), /\/new/)
})

test('áudio é apagado do disco depois de transcrito', async () => {
  const { handler, dir } = montar()
  const caminho = arquivoFalso(dir, 'audio.ogg')

  await handler.handle({ text: '', media: { kind: 'audio', path: caminho } })

  assert.equal(existsSync(caminho), false)
})

test('transcrição que falha avisa o motivo e não chama o claude', async () => {
  let chamou = false
  const { handler, ditos, dir } = montar({
    run: async () => { chamou = true },
    transcribe: async () => ({ ok: false, text: '', error: 'a OpenAI respondeu 429' }),
  })

  await handler.handle({ text: '', media: { kind: 'audio', path: arquivoFalso(dir, 'audio.ogg') } })

  assert.equal(chamou, false)
  assert.match(ditos.at(-1), /429/)
})

test('áudio é apagado do disco mesmo quando a transcrição falha', async () => {
  const { handler, dir } = montar({
    transcribe: async () => ({ ok: false, text: '', error: 'deu ruim' }),
  })
  const caminho = arquivoFalso(dir, 'audio.ogg')

  await handler.handle({ text: '', media: { kind: 'audio', path: caminho } })

  assert.equal(existsSync(caminho), false)
})

test('sem chave da OpenAI o áudio avisa que falta a chave e o texto segue funcionando', async () => {
  const { handler, ditos, dir } = montar({
    transcribe: transcribeReal,
    config: { openaiApiKey: null },
  })

  await handler.handle({ text: '', media: { kind: 'audio', path: arquivoFalso(dir, 'audio.ogg') } })
  assert.match(ditos.at(-1), /chave/i)

  await handler.handle('e o texto?')
  assert.equal(ditos.at(-1), '[s1] resposta')
})

// --- conta pessoal (/wpp) ---

function montarComWpp({ run, undo, classify, listAgents, formalizar = async ({ texto }) => `Prezada, ${texto}.` } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'handler-wpp-'))
  const db = openDb(':memory:')
  const outbox = createOutbox({ db, now: () => 1000 })
  const ditos = []
  const passadas = []
  const pedidos = []

  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  const handler = createHandler({
    classify,
    listAgents,
    sessions,
    run: run ?? (async ({ cwd, prompt }) => { pedidos.push({ cwd, prompt }); return { ok: true, text: 'rascunho pronto', sessionId: 'sid', error: null } }),
    transcribe: async () => ({ ok: true, text: '', error: null }),
    reply: async (t) => { ditos.push(t) },
    config: { slowNoticeMs: 10, timeoutMs: 1000, maxMessageChars: 500, claudeBin: 'claude', defaultCwd: dir },
    wpp: {
      outbox,
      agentCwd: dir,
      tick: async () => { passadas.push(1) },
      undo: undo ?? (async () => ({ ok: true, job: { chat_name: 'Jane', body: 'traz o macbook' } })),
      botContatos: () => [{ number: '5511911111111', name: 'Rogerio Garcia', last_sent_at: Math.floor(Date.now() / 1000) - 600 }],
      formalizar,
    },
  })

  const rascunho = (extra = {}) =>
    outbox.create({ chatJid: '5@s.whatsapp.net', chatName: 'Jane', body: 'traz o macbook', ...extra })

  return { handler, outbox, ditos, passadas, rascunho, pedidos, sessions, dir }
}

test('/wpp manda o pedido para a sessão dedicada, sem trocar a ativa e sem etiqueta', async () => {
  const { handler, ditos } = montarComWpp()
  await handler.handle('/new ~ trabalho')
  await handler.handle('/wpp olhe o grupo de líderes')
  // The butler speaks as himself: no [wpp] in front of what he says.
  assert.equal(ditos.at(-1), 'rascunho pronto')
  await handler.handle('/ls')
  assert.match(ditos.at(-1), /\* trabalho/)
})

test('/ok aprova e faz a mensagem sair na hora', async () => {
  const { handler, outbox, ditos, passadas, rascunho } = montarComWpp()
  const d = rascunho()
  await handler.handle(`/ok ${d.id}`)
  assert.equal(outbox.get(d.id).status, 'approved')
  assert.equal(outbox.get(d.id).sender, 'me')
  assert.equal(passadas.length, 1)
  assert.match(ditos.at(-1), /aprovad.*como você/i)
})

test('/bot num rascunho sem versão formal formaliza antes e aprova com ela', async () => {
  const { handler, outbox, ditos, passadas, rascunho } = montarComWpp()
  const d = rascunho()
  await handler.handle(`/bot ${d.id}`)
  const depois = outbox.get(d.id)
  assert.equal(depois.status, 'approved')
  assert.equal(depois.sender, 'bot')
  assert.equal(depois.body_bot, 'Prezada, traz o macbook.')
  assert.equal(depois.body, 'traz o macbook', 'a versão "como você" continua intacta')
  assert.equal(passadas.length, 1)
  assert.match(ditos.at(-1), /pelo bot/)
  assert.match(ditos.at(-1), /Prezada, traz o macbook\./)
})

test('/bot com versão formal já pronta não chama o formalizador', async () => {
  let chamou = false
  const { handler, outbox, rascunho } = montarComWpp({ formalizar: async () => { chamou = true; return 'x' } })
  const d = rascunho({ bodyBot: 'Olá, Jane. Por favor, traga o MacBook.' })
  await handler.handle(`/bot ${d.id}`)
  assert.equal(chamou, false)
  assert.equal(outbox.get(d.id).body_bot, 'Olá, Jane. Por favor, traga o MacBook.')
})

test('/bot não aprova nada se a formalização falhar: nunca sai informal pelo bot', async () => {
  const { handler, outbox, ditos, passadas, rascunho } = montarComWpp({ formalizar: async () => { throw new Error('claude fora') } })
  const d = rascunho()
  await handler.handle(`/bot ${d.id}`)
  assert.equal(outbox.get(d.id).status, 'pending')
  assert.equal(passadas.length, 0)
  assert.match(ditos.at(-1), /nada foi enviado/)
})

test('/edit apaga a versão formal antiga: o /bot refaz a partir do texto novo', async () => {
  const { handler, outbox, rascunho } = montarComWpp()
  const d = rascunho({ bodyBot: 'Olá, Jane. Traga o MacBook.' })
  await handler.handle(`/edit ${d.id} traz o carregador`)
  assert.equal(outbox.get(d.id).body_bot, null)
  await handler.handle(`/bot ${d.id}`)
  assert.equal(outbox.get(d.id).body_bot, 'Prezada, traz o carregador.')
})

test('/bot depois de /ok não troca a decisão já tomada', async () => {
  const { handler, outbox, rascunho } = montarComWpp()
  const d = rascunho()
  await handler.handle(`/ok ${d.id}`)
  await handler.handle(`/bot ${d.id}`)
  assert.equal(outbox.get(d.id).sender, 'me')
})

test('/ok em rascunho que não existe não inventa nada', async () => {
  const { handler, ditos, passadas } = montarComWpp()
  await handler.handle('/ok 99')
  assert.match(ditos.at(-1), /não achei/i)
  assert.equal(passadas.length, 0)
})

test('/ok duas vezes não manda duas vezes', async () => {
  const { handler, passadas, rascunho } = montarComWpp()
  const d = rascunho()
  await handler.handle(`/ok ${d.id}`)
  await handler.handle(`/ok ${d.id}`)
  assert.equal(passadas.length, 1)
})

test('/no descarta o rascunho pendente', async () => {
  const { handler, outbox, rascunho } = montarComWpp()
  const d = rascunho()
  await handler.handle(`/no ${d.id}`)
  assert.equal(outbox.get(d.id).status, 'rejected')
})

test('/no cancela um agendamento que você já tinha aprovado', async () => {
  const { handler, outbox, rascunho } = montarComWpp()
  const d = rascunho({ scheduledFor: 9999 })
  outbox.approve(d.id)
  await handler.handle(`/no ${d.id}`)
  assert.equal(outbox.get(d.id).status, 'canceled')
})

test('/schedulers mostra o que espera ok e o que está agendado', async () => {
  const { handler, outbox, ditos, rascunho } = montarComWpp()
  rascunho()
  const agendado = rascunho({ scheduledFor: 1756382400 })
  outbox.approve(agendado.id)

  await handler.handle('/schedulers')
  assert.match(ditos.at(-1), /Jane/)
  assert.match(ditos.at(-1), /Agendadas/)
})

test('/undo conta o que apagou', async () => {
  const { handler, ditos } = montarComWpp()
  await handler.handle('/undo')
  assert.match(ditos.at(-1), /Jane/)
})

test('/undo que falha explica o motivo', async () => {
  const { handler, ditos } = montarComWpp({ undo: async () => ({ ok: false, error: 'tarde demais' }) })
  await handler.handle('/undo')
  assert.match(ditos.at(-1), /tarde demais/)
})

test('sem conta pessoal configurada, os comandos avisam em vez de quebrar', async () => {
  const { handler, ditos } = montar()
  for (const cmd of ['/wpp oi', '/ok 1', '/no 1', '/undo', '/schedulers']) {
    await handler.handle(cmd)
    assert.match(ditos.at(-1), /conta pessoal/i, `falhou em ${cmd}`)
  }
})

test('/help cita os comandos da conta pessoal', async () => {
  const { handler, ditos } = montarComWpp()
  await handler.handle('/help')
  assert.match(ditos.at(-1), /\/wpp/)
  assert.match(ditos.at(-1), /\/schedulers/)
})

test('/edit troca o texto e devolve o card para aprovar', async () => {
  const { handler, outbox, ditos, rascunho } = montarComWpp()
  const d = rascunho()
  await handler.handle(`/edit ${d.id} Passando para lembrar de novo, não esquece do mac.`)
  assert.equal(outbox.get(d.id).body, 'Passando para lembrar de novo, não esquece do mac.')
  assert.match(ditos.at(-1), /não esquece do mac/)
  assert.match(ditos.at(-1), new RegExp(`/ok ${d.id}`))
})

test('/edit em algo já aprovado desarma o agendamento até você aprovar de novo', async () => {
  const { handler, outbox, ditos, rascunho } = montarComWpp()
  const d = rascunho({ scheduledFor: 9999 })
  outbox.approve(d.id)
  await handler.handle(`/edit ${d.id} texto novo`)
  assert.equal(outbox.get(d.id).status, 'pending')
  assert.deepEqual(outbox.due(99999), [])
  assert.match(ditos.at(-1), /ok/i)
})

test('/edit sem texto explica o uso em vez de apagar o rascunho', async () => {
  const { handler, outbox, ditos, rascunho } = montarComWpp()
  const d = rascunho()
  await handler.handle(`/edit ${d.id}`)
  assert.equal(outbox.get(d.id).body, 'traz o macbook')
  assert.match(ditos.at(-1), /uso:/i)
})

test('/edit no que já saiu avisa que é tarde', async () => {
  const { handler, outbox, ditos, rascunho } = montarComWpp()
  const d = rascunho()
  outbox.approve(d.id)
  outbox.markSent(d.id, 'WA-1')
  await handler.handle(`/edit ${d.id} tarde demais`)
  assert.equal(outbox.get(d.id).body, 'traz o macbook')
  assert.match(ditos.at(-1), /não achei/i)
})

test('/edit preserva o texto com acentos e pontuação', async () => {
  const { handler, outbox, rascunho } = montarComWpp()
  const d = rascunho()
  await handler.handle(`/edit ${d.id} Opa! Já conseguiu? Não esquece — é hoje.`)
  assert.equal(outbox.get(d.id).body, 'Opa! Já conseguiu? Não esquece — é hoje.')
})

test('/help cita o /edit', async () => {
  const { handler, ditos } = montarComWpp()
  await handler.handle('/help')
  assert.match(ditos.at(-1), /\/edit/)
})

test('/wpp corrige uma sessão pré-existente que aponta para o diretório errado', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handler-wpp2-'))
  const outro = mkdtempSync(join(tmpdir(), 'errado-'))
  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })

  // Uma sessão chamada wpp criada à mão antes do comando existir.
  sessions.create({ cwd: outro, name: 'wpp' })

  const ditos = []
  const handler = createHandler({
    sessions,
    run: async ({ cwd }) => ({ ok: true, text: `rodei em ${cwd}`, sessionId: 'sid', error: null }),
    transcribe: async () => ({ ok: true, text: '', error: null }),
    reply: async (t) => { ditos.push(t) },
    config: { slowNoticeMs: 10, timeoutMs: 1000, maxMessageChars: 500, claudeBin: 'claude', defaultCwd: dir },
    wpp: { outbox: createOutbox({ db: openDb(':memory:') }), agentCwd: dir, tick: async () => {}, undo: async () => ({ ok: false }) },
  })

  await handler.handle('/wpp olha o grupo')
  assert.equal(sessions.get('wpp').cwd, dir, 'a sessão devia ter sido reapontada para o agentCwd')
  assert.match(ditos.at(-1), new RegExp(dir))
})

// 28/08: um pedido foi reconhecido com "Trabalhando nisso.", o daemon foi
// reiniciado no meio, e a resposta nunca chegou. Todo pedido reconhecido
// precisa de um desfecho — sucesso, erro ou "fui interrompido".
test('o pedido em voo fica registrado no estado e sai de lá ao terminar', async () => {
  let vistoDuranteORun = null
  const { handler, sessions } = montar({
    run: async () => {
      vistoDuranteORun = sessions.active().pending?.prompt
      return { ok: true, text: 'feito', sessionId: 'sid-1', error: null }
    },
  })
  await handler.handle('faz a coisa demorada')
  assert.equal(vistoDuranteORun, 'faz a coisa demorada')
  assert.equal(sessions.active().pending, null)
})

test('o pedido em voo é limpo mesmo quando o run falha', async () => {
  const { handler, sessions } = montar({
    run: async () => ({ ok: false, text: '', sessionId: null, error: 'explodiu' }),
  })
  await handler.handle('faz a coisa')
  assert.equal(sessions.active().pending, null)
})

// run() rejeitando de verdade (não resolvendo {ok:false, error}, que é o jeito
// normal dele reportar falha) é um caminho diferente — antes disso ser
// tratado, a exceção pulava direto por cima da continuação que drena a fila,
// deixando a mensagem seguinte órfã pra sempre.
test('run() que rejeita (não só {ok:false}) ainda avisa o erro e drena a fila', async () => {
  let liberar
  const espera = new Promise((r) => { liberar = r })
  const processados = []
  const { handler, sessions, ditos } = montar({
    run: async ({ prompt }) => {
      processados.push(prompt)
      if (processados.length === 1) { await espera; throw new Error('caiu de verdade') }
      return { ok: true, text: 'segunda foi', sessionId: 'sid-2', error: null }
    },
  })

  const primeira = handler.handle('primeira')
  await new Promise((r) => setImmediate(r)) // deixa 'primeira' ocupar a sessão
  const segunda = handler.handle('segunda') // enfileira atrás da que vai rejeitar
  liberar()
  await Promise.all([primeira, segunda])

  assert.match(ditos.join('\n'), /Erro: caiu de verdade/, 'o usuário recebe o erro, não fica sem resposta nenhuma')
  assert.deepEqual(processados, ['primeira', 'segunda'], 'a mensagem enfileirada não fica órfã')
  assert.equal(sessions.active().busy, false)
})

test('recuperar() avisa sobre o pedido que morreu no restart', async () => {
  const { handler, sessions, ditos, dir } = montar()
  sessions.create({ cwd: dir, name: 'api' })
  sessions.beginRun('api', 'aquele pedido longo')

  await handler.recuperar()
  const aviso = ditos.join('\n')
  assert.match(aviso, /interromp/i)
  assert.match(aviso, /aquele pedido longo/)
  assert.match(aviso, /\/retomar api/)
})

test('reply() falhando ao entregar a resposta final não trava a fila atrás dela', async () => {
  let liberar
  const espera = new Promise((r) => { liberar = r })
  let chamadas = 0
  const processados = []
  const dir = mkdtempSync(join(tmpdir(), 'handler-'))
  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  const reply = async () => {
    chamadas += 1
    if (chamadas === 1) throw new Error('whatsapp fora do ar')
  }
  const handler = createHandler({
    sessions,
    run: async ({ prompt }) => {
      processados.push(prompt)
      if (processados.length === 1) await espera
      return { ok: true, text: 'ok', sessionId: 'sid-1', error: null }
    },
    transcribe: async () => ({ ok: true, text: '', error: null }),
    reply,
    config: { slowNoticeMs: 10, timeoutMs: 1000, maxMessageChars: 50, claudeBin: 'claude', defaultCwd: dir },
  })

  const primeira = handler.handle('primeira')
  await new Promise((r) => setImmediate(r)) // deixa 'primeira' ocupar a sessão antes de mandar a próxima
  const segunda = handler.handle('segunda') // enfileira, já que 'primeira' ainda está rodando
  liberar()
  await Promise.all([primeira, segunda])

  assert.deepEqual(processados, ['primeira', 'segunda'], 'segunda roda mesmo com a entrega da resposta de primeira falhando')
})

test('o agente que segura o turno vai para o disco assim que é conhecido, antes do turno acabar', async () => {
  let liberar
  const espera = new Promise((r) => { liberar = r })
  let disparou
  const disparado = new Promise((r) => { disparou = r })
  const { handler, dir } = montar({
    run: async ({ onDispatch }) => {
      onDispatch({ bgId: 'abc12345', sessionId: 'sid-novo' })
      disparou()
      await espera
      return { ok: true, text: 'fim', sessionId: 'sid-novo', error: null }
    },
  })

  const turno = handler.handle('um pedido')
  await disparado
  // What a restart would find: a fresh process reading the same state file.
  const depois = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  const s = depois.list()[0]
  assert.equal(s.pending.bgId, 'abc12345')
  assert.equal(s.pending.sessionId, 'sid-novo')
  assert.equal(s.claudeSessionId, 'sid-novo', 'uma sessão nova já sabe seu id antes de o turno terminar')

  liberar()
  await turno
})

test('recuperar() reanexa ao agente que ainda está rodando em vez de oferecer /retomar', async () => {
  const anexados = []
  const { handler, sessions, ditos, dir } = montar({
    listAgents: async () => [{ id: 'abc12345', sessionId: 'sid-1', status: 'busy' }],
    attach: async (opcoes) => {
      anexados.push(opcoes)
      return { ok: true, text: 'terminou depois do restart', sessionId: 'sid-1', error: null }
    },
    run: async () => { throw new Error('não pode re-executar o pedido') },
  })
  sessions.create({ cwd: dir, name: 'api' })
  sessions.beginRun('api', 'aquele pedido longo')
  sessions.markDispatched('api', { bgId: 'abc12345', sessionId: 'sid-1' })
  const { startedAt } = sessions.get('api').pending

  await handler.recuperar()
  while (sessions.get('api').busy) await new Promise((r) => setImmediate(r))

  assert.equal(anexados.length, 1)
  assert.equal(anexados[0].bgId, 'abc12345')
  assert.equal(anexados[0].sessionId, 'sid-1')
  assert.equal(anexados[0].sentAt, startedAt)
  const tudo = ditos.join('\n')
  assert.match(tudo, /continua rodando/)
  assert.match(tudo, /terminou depois do restart/)
  assert.doesNotMatch(tudo, /\/retomar/)
  assert.equal(sessions.get('api').pending, null)
})

test('recuperar() com o agente já fora da lista cai no aviso de /retomar de sempre', async () => {
  let anexou = false
  const { handler, sessions, ditos, dir } = montar({
    listAgents: async () => [],
    attach: async () => { anexou = true; return { ok: true, text: '', sessionId: null, error: null } },
  })
  sessions.create({ cwd: dir, name: 'api' })
  sessions.beginRun('api', 'aquele pedido longo')
  sessions.markDispatched('api', { bgId: 'abc12345', sessionId: 'sid-1' })

  await handler.recuperar()
  assert.equal(anexou, false)
  assert.match(ditos.join('\n'), /\/retomar api/)
})

test('recuperar() não confia numa listagem que falhou: pergunta em vez de reanexar', async () => {
  let anexou = false
  const { handler, sessions, ditos, dir } = montar({
    listAgents: async () => { throw new Error('claude agents fora do ar') },
    attach: async () => { anexou = true; return { ok: true, text: '', sessionId: null, error: null } },
  })
  sessions.create({ cwd: dir, name: 'api' })
  sessions.beginRun('api', 'aquele pedido longo')
  sessions.markDispatched('api', { bgId: 'abc12345', sessionId: 'sid-1' })

  await handler.recuperar()
  assert.equal(anexou, false)
  assert.match(ditos.join('\n'), /\/retomar api/)
})

test('resposta longa vai como anexo com a prévia na legenda, não como uma fila de balões', async () => {
  const longa = Array.from({ length: 40 }, (_, i) => `linha ${i} ${'x'.repeat(20)}`).join('\n')
  const anexos = []
  const { handler, ditos } = montar({
    run: async () => ({ ok: true, text: longa, sessionId: 'sid-1', error: null }),
    replyFile: async (doc) => { anexos.push(doc) },
    config: { attachAboveChars: 200, slowNoticeMs: 10_000 },
  })

  await handler.handle('/new . api')
  ditos.length = 0
  await handler.handle('me dá o relatório')

  assert.equal(anexos.length, 1)
  assert.equal(anexos[0].content, longa, 'o anexo leva a resposta inteira, sem cortes')
  assert.equal(anexos[0].fileName, 'api.txt')
  assert.match(anexos[0].caption, /^\[api\] linha 0/)
  assert.match(anexos[0].caption, new RegExp(`${longa.length} caracteres`))
  assert.deepEqual(ditos, [], 'nenhum balão de texto além do anexo')
})

test('resposta curta continua indo como texto, sem anexo', async () => {
  const anexos = []
  const { handler, ditos } = montar({
    replyFile: async (doc) => { anexos.push(doc) },
    config: { attachAboveChars: 200, slowNoticeMs: 10_000 },
  })
  await handler.handle('oi')
  assert.equal(anexos.length, 0)
  assert.ok(ditos.some((t) => t.includes('resposta')))
})

test('arquivo marcado pelo Claude vai como anexo, e a marca some do texto', async () => {
  const anexos = []
  const pasta = mkdtempSync(join(tmpdir(), 'saida-'))
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff])
  writeFileSync(join(pasta, 'grafico.png'), bytes)
  const { handler, ditos } = montar({
    run: async () => ({ ok: true, text: `Fiz o gráfico.\n\n[[arquivo: ${join(pasta, 'grafico.png')}]]\n\nQualquer coisa, avisa.`, sessionId: 'sid-1', error: null }),
    replyFile: async (doc) => { anexos.push(doc) },
    config: { slowNoticeMs: 10_000, maxMessageChars: 3500 },
  })
  await handler.handle('faz um gráfico')

  assert.equal(anexos.length, 1)
  assert.ok(anexos[0].content.equals(bytes), 'bytes do arquivo intactos')
  assert.equal(anexos[0].fileName, 'grafico.png')
  assert.equal(anexos[0].mimetype, 'image/png')
  const texto = ditos.join('\n')
  assert.match(texto, /Fiz o gráfico\.\n\nQualquer coisa, avisa\./)
  assert.doesNotMatch(texto, /\[\[arquivo/)
})

test('caminho relativo na marca resolve a partir da pasta da sessão', async () => {
  const anexos = []
  const { handler, dir } = montar({
    run: async () => ({ ok: true, text: '[[arquivo: relatorio.csv]]', sessionId: 'sid-1', error: null }),
    replyFile: async (doc) => { anexos.push(doc) },
    config: { slowNoticeMs: 10_000 },
  })
  writeFileSync(join(dir, 'relatorio.csv'), 'a,b\n1,2\n')
  await handler.handle(`/new ${dir} api`)
  await handler.handle('gera o csv')
  assert.equal(anexos.length, 1)
  assert.equal(anexos[0].content.toString(), 'a,b\n1,2\n')
  assert.equal(anexos[0].mimetype, 'text/csv')
})

test('só a marca, sem texto: manda o anexo e nenhum balão vazio', async () => {
  const pasta = mkdtempSync(join(tmpdir(), 'saida-'))
  writeFileSync(join(pasta, 'a.txt'), 'x')
  const { handler, ditos } = montar({
    run: async () => ({ ok: true, text: `[[arquivo: ${join(pasta, 'a.txt')}]]`, sessionId: 'sid-1', error: null }),
    replyFile: async () => {},
    config: { slowNoticeMs: 10_000 },
  })
  await handler.handle('manda')
  assert.ok(!ditos.some((t) => /^\[s1\]\s*$/.test(t)), 'sem balão vazio')
})

test('marca apontando para arquivo que não existe avisa em vez de sumir', async () => {
  const anexos = []
  const { handler, ditos } = montar({
    run: async () => ({ ok: true, text: 'Segue.\n[[arquivo: /nao/existe.pdf]]', sessionId: 'sid-1', error: null }),
    replyFile: async (doc) => { anexos.push(doc) },
    config: { slowNoticeMs: 10_000 },
  })
  await handler.handle('manda o pdf')
  assert.equal(anexos.length, 0)
  assert.ok(ditos.some((t) => t.includes('não achei o arquivo /nao/existe.pdf')))
})

test('documento do celular vira prompt com o caminho e o nome original', async () => {
  const prompts = []
  const { handler } = montar({
    run: async ({ prompt }) => { prompts.push(prompt); return { ok: true, text: 'ok', sessionId: 'sid-1', error: null } },
  })
  await handler.handle({ text: 'resume esse contrato', media: { kind: 'document', path: '/tmp/x/123-contrato.pdf', fileName: 'contrato.pdf' } })
  assert.match(prompts[0], /^resume esse contrato/)
  assert.match(prompts[0], /arquivo anexado \(contrato\.pdf\) em \/tmp\/x\/123-contrato\.pdf/)
})

test('documento sem legenda ganha o pedido padrão', async () => {
  const prompts = []
  const { handler } = montar({
    run: async ({ prompt }) => { prompts.push(prompt); return { ok: true, text: 'ok', sessionId: 'sid-1', error: null } },
  })
  await handler.handle({ text: '', media: { kind: 'document', path: '/tmp/x/1-a.xlsx', fileName: 'a.xlsx' } })
  assert.match(prompts[0], /^Analise o arquivo anexado\./)
})

test('documento grande demais é recusado sem rodar o Claude', async () => {
  let rodou = false
  const { handler, ditos } = montar({ run: async () => { rodou = true; return { ok: true, text: '', sessionId: null, error: null } } })
  await handler.handle({ text: 'olha', media: { kind: 'document', fileName: 'backup.zip', size: 80 * 1024 * 1024, tooLarge: true } })
  assert.equal(rodou, false)
  assert.match(ditos.at(-1), /backup\.zip tem 80 MB/)
})

test('anexo que falha ao sair cai para os balões de texto: a resposta nunca se perde', async () => {
  const longa = Array.from({ length: 40 }, (_, i) => `linha ${i}`).join('\n')
  const { handler, ditos } = montar({
    run: async () => ({ ok: true, text: longa, sessionId: 'sid-1', error: null }),
    replyFile: async () => { throw new Error('upload recusado') },
    config: { attachAboveChars: 100, maxMessageChars: 3500, slowNoticeMs: 10_000 },
  })
  await handler.handle('me dá o relatório')
  const tudo = ditos.join('\n')
  assert.match(tudo, /linha 0/)
  assert.match(tudo, /linha 39/)
})

test('recuperar() fica calado quando nada morreu no meio', async () => {
  const { handler, ditos, dir } = montar()
  await handler.recuperar()
  assert.deepEqual(ditos, [])
})

// A entrega de um aviso falhando (WhatsApp fora do ar, por exemplo) não pode
// abortar o loop inteiro e deixar as outras sessões interrompidas sem aviso
// nenhum.
test('recuperar() segue avisando as outras sessões mesmo se uma entrega falhar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handler-'))
  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  let chamadas = 0
  const reply = async (t) => {
    chamadas += 1
    if (chamadas === 1) throw new Error('whatsapp fora do ar')
    ditos.push(t)
  }
  const ditos = []
  const handler = createHandler({
    sessions,
    run: async () => ({ ok: true, text: 'resposta', sessionId: 'sid-1', error: null }),
    transcribe: async () => ({ ok: true, text: '', error: null }),
    reply,
    config: { slowNoticeMs: 10, timeoutMs: 1000, maxMessageChars: 50, claudeBin: 'claude', defaultCwd: dir },
  })
  sessions.create({ cwd: dir, name: 'a' })
  sessions.beginRun('a', 'pedido de a')
  sessions.create({ cwd: dir, name: 'b' })
  sessions.beginRun('b', 'pedido de b')

  await handler.recuperar()
  assert.match(ditos.join('\n'), /pedido de b/, 'o aviso de b chegou mesmo com a primeira entrega (de a) falhando')
})

test('/retomar reexecuta o pedido interrompido', async () => {
  const enviados = []
  const { handler, sessions, dir } = montar({
    run: async ({ prompt }) => {
      enviados.push(prompt)
      return { ok: true, text: 'agora foi', sessionId: 'sid-1', error: null }
    },
  })
  sessions.create({ cwd: dir, name: 'api' })
  sessions.beginRun('api', 'aquele pedido longo')

  await handler.handle('/retomar api')
  assert.deepEqual(enviados, ['aquele pedido longo'])
  assert.equal(sessions.get('api').pending, null)
})

test('/retomar sem nada interrompido avisa em vez de inventar', async () => {
  const { handler, ditos, dir } = montar()
  await handler.handle('/retomar')
  assert.match(ditos.at(-1), /nada/i)
})

// Reportado pela auditoria: uma mensagem comum enviada a uma sessão com um
// pending sobrevivente de um restart não pode simplesmente sobrescrevê-lo —
// beginRun() troca o pending incondicionalmente, então o pedido antigo
// desapareceria sem rastro, sem o usuário nunca ter mandado /retomar ou
// /descartar.
test('mensagem comum não sobrescreve um pending sobrevivente de restart', async () => {
  const enviados = []
  const { handler, sessions, ditos, dir } = montar({
    run: async ({ prompt }) => { enviados.push(prompt); return { ok: true, text: 'ok', sessionId: 'sid-1', error: null } },
  })
  sessions.create({ cwd: dir, name: 'api' })
  sessions.beginRun('api', 'pedido antigo interrompido')

  await handler.handle('@api mensagem nova')

  assert.deepEqual(enviados, [], 'não deve ter rodado nada ainda')
  assert.equal(sessions.get('api').pending.prompt, 'pedido antigo interrompido', 'o pending antigo continua intacto')
  assert.deepEqual(sessions.get('api').queue, ['mensagem nova'], 'a mensagem nova foi guardada, não perdida')
  assert.match(ditos.at(-1), /\/retomar api|\/descartar api/)

  // Depois que /retomar resolve o pending antigo, a mensagem nova enfileirada
  // é processada na sequência, sem precisar ser reenviada.
  await handler.handle('/retomar api')
  assert.deepEqual(enviados, ['pedido antigo interrompido', 'mensagem nova'])
})

test('/descartar joga fora o pedido interrompido', async () => {
  const enviados = []
  const { handler, sessions, dir } = montar({
    run: async ({ prompt }) => { enviados.push(prompt); return { ok: true, text: 'x', sessionId: null, error: null } },
  })
  sessions.create({ cwd: dir, name: 'api' })
  sessions.beginRun('api', 'aquele pedido longo')

  await handler.handle('/descartar api')
  assert.equal(sessions.get('api').pending, null)
  assert.deepEqual(enviados, [])
})

// Sem teto de tempo, o silêncio prolongado é indistinguível de um travamento.
test('o heartbeat vira aviso de progresso, sem repetir "Trabalhando nisso."', async () => {
  const { handler, ditos } = montar({
    run: async ({ onSlow }) => {
      onSlow(9000)
      onSlow(310000)
      return { ok: true, text: 'demorou mas saiu', sessionId: 'sid-1', error: null }
    },
  })
  await handler.handle('tarefa longa')
  assert.equal(ditos[0], 'Trabalhando nisso.')
  assert.match(ditos[1], /ainda/i)
  assert.match(ditos[1], /5min/)
})

test('citar uma resposta encaminhada responde à pessoa e não chega ao Claude', async () => {
  const { relay, enviados } = await relayComResposta()
  let rodou = false
  const { handler, ditos } = montar({ relay, run: async () => { rodou = true; return { ok: true, text: '', sessionId: null, error: null } } })
  await handler.handle({ text: 'fechado', media: null, raw: citando('OWNER-1') })
  assert.equal(rodou, false)
  assert.deepEqual(enviados, [{ jid: '5511911111111@s.whatsapp.net', texto: 'Olá. Confirmado para amanhã.' }])
  assert.match(ditos.at(-1), /Mandei pelo bot para 5511911111111/)
  assert.match(ditos.at(-1), /Confirmado para amanhã/)
})

test('/r responde pelo número da mensagem encaminhada', async () => {
  const { relay, enviados } = await relayComResposta()
  const { handler } = montar({ relay })
  await handler.handle('/r 1 fechado')
  assert.equal(enviados.length, 1)
})

test('citar uma mensagem qualquer segue o caminho normal da sessão', async () => {
  const { relay, enviados } = await relayComResposta()
  let rodou = false
  const { handler } = montar({ relay, run: async () => { rodou = true; return { ok: true, text: 'ok', sessionId: 's', error: null } } })
  await handler.handle({ text: 'e isso?', media: null, raw: citando('OUTRA-MSG') })
  assert.equal(rodou, true)
  assert.equal(enviados.length, 0)
})

test('sem conta pessoal, palavras viram comando e o texto solto vai para a sessão', async () => {
  const prompts = []
  const { handler, ditos } = montar({
    classify: async (p) => { prompts.push(p); return '/ls' },
    run: async () => { throw new Error('não devia ir para a sessão') },
  })
  await handler.handle('quais sessões estão abertas?')
  assert.match(prompts[0], /quais sessões estão abertas\?/)
  assert.equal(ditos[0], '🗣️ Entendi: /ls')
  assert.match(ditos[1], /Nenhuma sessão aberta/)

  const pedidos = []
  const outro = montar({
    classify: async () => 'NENHUM',
    run: async ({ prompt }) => { pedidos.push(prompt); return { ok: true, text: 'feito', sessionId: 's', error: null } },
  })
  await outro.handler.handle('refatora o parser')
  assert.deepEqual(pedidos, ['refatora o parser'])
})

test('sem conta pessoal, classificador que falha ou comando digitado não atrapalham', async () => {
  const pedidos = []
  const { handler } = montar({
    classify: async () => { throw new Error('claude fora') },
    run: async ({ prompt }) => { pedidos.push(prompt); return { ok: true, text: 'feito', sessionId: 's', error: null } },
  })
  await handler.handle('aprova tudo')
  assert.deepEqual(pedidos, ['aprova tudo'])

  let classificou = 0
  const outro = montar({ classify: async () => { classificou++; return '/ls' } })
  await outro.handler.handle('/ls')
  await outro.handler.handle('/new ~ s9')
  await outro.handler.handle('@s9 oi')
  assert.equal(classificou, 0)
})

test('com o Claudinei, o classificador fica fora do caminho', async () => {
  let classificou = 0
  const { handler, pedidos, outbox, rascunho, ditos } = montarComWpp({
    classify: async () => { classificou++; return '/no 1' },
  })
  const d = rascunho()
  await handler.handle('descarta esse rascunho')

  assert.equal(classificou, 0, 'ninguém corre com ele')
  assert.equal(outbox.get(d.id).status, 'pending', 'quem decide é o Claudinei, não o atalho')
  assert.equal(pedidos.at(-1).prompt.split('\n')[0], 'descarta esse rascunho')
  assert.ok(!ditos.some((t) => t.startsWith('🗣️')), 'e ele não devolve "Entendi: /comando"')
})

test('tudo o que ele escreve sem barra vai para o Claudinei, não para a sessão de código', async () => {
  const { handler, pedidos, sessions, ditos } = montarComWpp({ classify: async () => 'NENHUM' })
  await handler.handle('/new ~ infra')
  await handler.handle('avisa meu pai que paguei os documentos')
  await handler.handle('rogerio garcia')

  assert.equal(sessions.active().name, 'infra', 'a sessão ativa continua sendo a de código')
  assert.equal(pedidos.length, 2)
  assert.match(pedidos[0].prompt, /avisa meu pai/)
  assert.equal(pedidos[1].prompt, 'rogerio garcia', 'a resposta seguinte também é com ele')
  assert.equal(ditos.at(-1), 'rascunho pronto', 'e ele fala sem etiqueta')
})

test('decidir um rascunho não tira a conversa do Claudinei', async () => {
  const { handler, pedidos, rascunho } = montarComWpp({ classify: async () => 'NENHUM' })
  await handler.handle('/new ~ infra')
  rascunho()
  await handler.handle('/no 1')
  await handler.handle('e aí, o que ficou pendente?')
  assert.equal(pedidos.at(-1).prompt, 'e aí, o que ficou pendente?')
  assert.equal(pedidos.length, 1, 'só o Claudinei recebeu')
})

test('@sessão continua sendo como ele fala direto com uma sessão de código', async () => {
  const { handler, pedidos } = montarComWpp({ classify: async () => 'NENHUM' })
  await handler.handle('/new ~ infra')
  await handler.handle('@infra roda os testes')
  assert.equal(pedidos.at(-1).prompt, 'roda os testes')

  await handler.handle('e o lint?')
  assert.equal(pedidos.at(-1).prompt, 'e o lint?')
  assert.equal(pedidos.length, 2)
})

test('uma tarefa agendada chega ao Claudinei com a hora e como encerrar', async () => {
  const { handler, pedidos } = montarComWpp({})
  await handler.rodarTarefa({ id: 7, prompt: 'confere o chamado da AWS e me conta', label: 'cota aws' })

  const enviado = pedidos.at(-1).prompt
  assert.match(enviado, /tarefa agendada #7 — cota aws/)
  assert.match(enviado, /act\.mjs tarefa-fim --id 7/)
  assert.match(enviado, /confere o chamado da AWS e me conta$/)
})

test('o Claudinei despacha trabalho para uma sessão de projeto, e nunca para si mesmo', async () => {
  const { handler, pedidos, sessions } = montarComWpp({ classify: async () => 'NENHUM' })
  await handler.handle('/new ~ infra')
  await handler.handle('oi')  // cria a sessão do Claudinei

  const r = await handler.despacharDeFora({ session: 'infra', prompt: 'roda os testes' })
  assert.deepEqual(r, { ok: true, session: 'infra' })
  await new Promise((ok) => setTimeout(ok, 50))
  assert.equal(pedidos.at(-1).prompt, 'roda os testes')

  assert.equal((await handler.despacharDeFora({ session: 'wpp', prompt: 'x' })).ok, false)
  assert.match((await handler.despacharDeFora({ session: 'nao-existe', prompt: 'x' })).error, /Não achei a sessão/)
  void sessions
})

test('o pedido do /wpp leva quem o bot já contatou, para não cumprimentar de novo', async () => {
  const { handler, pedidos } = montarComWpp({})
  await handler.handle('/wpp avisa o Rogério que paguei')
  assert.match(pedidos[0].prompt, /já conversou com estas pessoas/)
  assert.match(pedidos[0].prompt, /Rogerio Garcia \(5511911111111\)/)
  assert.match(pedidos[0].prompt, /sem cumprimentar nem se apresentar de novo/)
})

test('a sessão do wpp é refeita quando as instruções do agente mudam', async () => {
  const { handler, sessions, dir } = montarComWpp({})
  await handler.handle('/wpp primeira')
  const antes = sessions.get('wpp').createdAt

  writeFileSync(join(dir, 'CLAUDE.md'), '# instruções novas')
  // Explicit mtime: written in the same millisecond, "newer" is a coin toss.
  const daquiAPouco = new Date(Date.now() + 5000)
  utimesSync(join(dir, 'CLAUDE.md'), daquiAPouco, daquiAPouco)
  await handler.handle('/wpp segunda')
  assert.notEqual(sessions.get('wpp').createdAt, antes, 'devia ter recriado a sessão')
})

// A session he started himself, outside the bot, as `claude agents` lists it.
const noHost = (nome, id, extra = {}) => ({ name: nome, sessionId: id, cwd: tmpdir(), kind: 'background', status: 'idle', ...extra })

test('@nome usa a sessão que ELE abriu no host, não a homônima do bot', async () => {
  const { handler, sessions, ditos, pedidos } = montarComWpp({
    listAgents: async () => [noHost('infra', 'DELE-1')],
    run: async ({ sessionId }) => ({ ok: true, text: 'ok', sessionId: sessionId ?? 'novo', error: null }),
  })
  await handler.handle('/new ~ infra')
  sessions.get('infra').claudeSessionId = 'DO-BOT'

  await handler.handle('@infra roda os testes')

  assert.equal(sessions.get('infra').claudeSessionId, 'DELE-1', 'o nome passou a apontar para a dele')
  assert.equal(sessions.get('infra').cwd, tmpdir())
  assert.ok(ditos.some((t) => /passei a usar a sua sessão infra/.test(t)))
  assert.equal(ditos.at(-1), '[infra] ok', 'e o pedido foi para ela')
  void pedidos
})

test('e continua apontada para ela, sem repetir o aviso', async () => {
  const { handler, sessions, ditos } = montarComWpp({
    listAgents: async () => [noHost('infra', 'DELE-1')],
    run: async ({ sessionId }) => ({ ok: true, text: 'ok', sessionId: sessionId ?? 'novo', error: null }),
  })
  await handler.handle('@infra oi')
  const avisos = ditos.filter((t) => /passei a usar/.test(t)).length
  await handler.handle('@infra de novo')

  assert.equal(sessions.get('infra').claudeSessionId, 'DELE-1')
  assert.equal(ditos.filter((t) => /passei a usar/.test(t)).length, avisos, 'avisou uma vez só')
})

test('sessão do host já rastreada pelo bot não é readotada', async () => {
  const { handler, sessions, ditos } = montarComWpp({
    listAgents: async () => [noHost('infra', 'DELE-1')],
    run: async ({ sessionId }) => ({ ok: true, text: 'ok', sessionId: sessionId ?? 'novo', error: null }),
  })
  await handler.handle('@infra oi')
  ditos.length = 0
  await handler.handle('@infra e aí')
  assert.equal(sessions.get('infra').claudeSessionId, 'DELE-1')
  assert.ok(!ditos.some((t) => /passei a usar/.test(t)))
})

test('duas sessões com o mesmo nome: pergunta em vez de escolher uma', async () => {
  const { handler, ditos, pedidos } = montarComWpp({
    listAgents: async () => [noHost('infra', 'A'), { ...noHost('infra', 'B'), cwd: homedir() }],
  })
  const antes = pedidos.length
  await handler.handle('@infra roda os testes')

  assert.match(ditos.at(-1), /mais de uma sessão chamada infra/)
  assert.match(ditos.at(-1), new RegExp(tmpdir()))
  assert.equal(pedidos.length, antes, 'e não despachou para nenhuma')
})

test('sessão do host encerrada é ignorada; vale a do bot', async () => {
  const { handler, sessions, ditos } = montarComWpp({
    listAgents: async () => [noHost('infra', 'MORTA', { status: undefined, state: 'done' })],
    run: async ({ sessionId }) => ({ ok: true, text: 'ok', sessionId: sessionId ?? 'novo', error: null }),
  })
  await handler.handle('/new ~ infra')
  sessions.get('infra').claudeSessionId = 'DO-BOT'
  await handler.handle('@infra oi')

  assert.equal(sessions.get('infra').claudeSessionId, 'DO-BOT')
  assert.equal(ditos.at(-1), '[infra] ok')
})

test('o despacho do Claudinei resolve o nome do mesmo jeito', async () => {
  const { handler, sessions } = montarComWpp({ listAgents: async () => [noHost('infra', 'DELE-1')] })
  await handler.handle('/new ~ infra')
  sessions.get('infra').claudeSessionId = 'DO-BOT'

  const r = await handler.despacharDeFora({ session: 'infra', prompt: 'sobe o risk-manager' })
  assert.equal(r.ok, true)
  assert.equal(sessions.get('infra').claudeSessionId, 'DELE-1')
})

test('retomar bifurca a conversa, e o nome não volta a adotar a original', async () => {
  // Claude Code files a resumed conversation under a brand-new id. Without
  // remembering where the name came from, the next message would adopt the
  // original again and fork from the same point, losing the exchange between.
  const { handler, sessions, ditos } = montarComWpp({
    listAgents: async () => [noHost('infra', 'DELE-1')],
    run: async () => ({ ok: true, text: 'ok', sessionId: 'BIFURCADA', error: null }),
  })

  await handler.handle('@infra oi')
  assert.equal(sessions.get('infra').claudeSessionId, 'BIFURCADA', 'o claude bifurcou')
  assert.equal(sessions.get('infra').adotadaDe, 'DELE-1', 'mas lembramos de onde veio')

  ditos.length = 0
  await handler.handle('@infra e aí')
  assert.equal(sessions.get('infra').claudeSessionId, 'BIFURCADA', 'seguiu na mesma conversa')
  assert.ok(!ditos.some((t) => /passei a usar/.test(t)))
})
