import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createStore } from '../src/store.js'
import { createSessions } from '../src/sessions.js'
import { createHandler } from '../src/handler.js'
import { transcribe as transcribeReal } from '../src/transcribe.js'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'

function montar({ run, transcribe, config } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'handler-'))
  const sessions = createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir })
  const ditos = []
  const handler = createHandler({
    sessions,
    run: run ?? (async () => ({ ok: true, text: 'resposta', sessionId: 'sid-1', error: null })),
    transcribe: transcribe ?? (async () => ({ ok: true, text: 'transcrição do áudio', error: null })),
    reply: async (t) => { ditos.push(t) },
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

function montarComWpp({ run, undo } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'handler-wpp-'))
  const db = openDb(':memory:')
  const outbox = createOutbox({ db, now: () => 1000 })
  const ditos = []
  const passadas = []

  const handler = createHandler({
    sessions: createSessions({ store: createStore(join(dir, 'state.json')), defaultCwd: dir }),
    run: run ?? (async () => ({ ok: true, text: 'rascunho pronto', sessionId: 'sid', error: null })),
    transcribe: async () => ({ ok: true, text: '', error: null }),
    reply: async (t) => { ditos.push(t) },
    config: { slowNoticeMs: 10, timeoutMs: 1000, maxMessageChars: 500, claudeBin: 'claude', defaultCwd: dir },
    wpp: {
      outbox,
      agentCwd: dir,
      tick: async () => { passadas.push(1) },
      undo: undo ?? (async () => ({ ok: true, job: { chat_name: 'Jane Doe', body: 'traz o macbook' } })),
    },
  })

  const rascunho = (extra = {}) =>
    outbox.create({ chatJid: '5@s.whatsapp.net', chatName: 'Jane Doe', body: 'traz o macbook', ...extra })

  return { handler, outbox, ditos, passadas, rascunho }
}

test('/wpp manda o pedido para a sessão dedicada, sem trocar a ativa', async () => {
  const { handler, ditos } = montarComWpp()
  await handler.handle('/new ~ trabalho')
  await handler.handle('/wpp olhe o grupo de líderes')
  assert.match(ditos.at(-1), /^\[wpp\]/)
  await handler.handle('/ls')
  assert.match(ditos.at(-1), /\* trabalho/)
})

test('/ok aprova e faz a mensagem sair na hora', async () => {
  const { handler, outbox, ditos, passadas, rascunho } = montarComWpp()
  const d = rascunho()
  await handler.handle(`/ok ${d.id}`)
  assert.equal(outbox.get(d.id).status, 'approved')
  assert.equal(passadas.length, 1)
  assert.match(ditos.at(-1), /aprovad/i)
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
  assert.match(ditos.at(-1), /Jane Doe/)
  assert.match(ditos.at(-1), /Agendadas/)
})

test('/undo conta o que apagou', async () => {
  const { handler, ditos } = montarComWpp()
  await handler.handle('/undo')
  assert.match(ditos.at(-1), /Jane Doe/)
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
