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
