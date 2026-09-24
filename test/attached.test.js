import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAttachedRunner, createTmux } from '../src/attached.js'

// A tmux that records what it was asked to do, instead of a terminal.
function tmuxFalso({ disponivel = true, viva = false, abrirOk = true, digitarOk = true } = {}) {
  const chamadas = []
  return {
    chamadas,
    tmux: {
      disponivel: async () => disponivel,
      viva: async (n) => { chamadas.push(['viva', n]); return viva },
      abrir: async (n, cmd, cwd) => { chamadas.push(['abrir', n, cmd, cwd]); return { ok: abrirOk, stderr: abrirOk ? '' : 'no server' } },
      digitar: async (n, texto) => { chamadas.push(['digitar', n, texto]); return { ok: digitarOk, stderr: digitarOk ? '' : 'sem sessão' } },
      matar: async (n) => { chamadas.push(['matar', n]); return { ok: true } },
    },
  }
}

// A transcript that answers with whatever the test lines up, in order.
function transcricao(sequencia) {
  let i = 0
  return async () => sequencia[Math.min(i++, sequencia.length - 1)]
}

const base = { nome: 'infra', cwd: '/tmp', agentId: 'b8d4e3c5', sessionId: 'sid-dele', prompt: 'roda os testes' }

test('digita na sessão dele e devolve a resposta nova da transcrição', async () => {
  const { tmux, chamadas } = tmuxFalso({ viva: true })
  const runAttached = createAttachedRunner({
    tmux,
    readReply: transcricao([
      { content: 'resposta velha', timestamp: '1' },
      { content: 'pronto', timestamp: '2' },
      { content: 'pronto', timestamp: '2' },
    ]),
    now: (() => { let t = 0; return () => (t += 7000) })(),
    sleep: async () => {},
  })

  const r = await runAttached({ ...base })
  assert.deepEqual(r, { ok: true, text: 'pronto', sessionId: 'sid-dele', janela: 'wpp-infra', abriu: false, error: null })
  assert.deepEqual(chamadas.find((c) => c[0] === 'digitar'), ['digitar', 'wpp-infra', 'roda os testes'])
  assert.ok(!chamadas.some((c) => c[0] === 'abrir'), 'a janela já estava viva')
})

test('abre a janela com claude attach quando ela não existe', async () => {
  const { tmux, chamadas } = tmuxFalso({ viva: false })
  const runAttached = createAttachedRunner({
    tmux,
    bin: 'claude',
    readReply: transcricao([null, { content: 'ok', timestamp: '9' }, { content: 'ok', timestamp: '9' }]),
    now: (() => { let t = 0; return () => (t += 7000) })(),
    sleep: async () => {},
  })

  const r = await runAttached({ ...base })
  assert.equal(r.ok, true)
  assert.deepEqual(chamadas.find((c) => c[0] === 'abrir'), ['abrir', 'wpp-infra', 'claude attach b8d4e3c5', '/tmp'])
})

test('a resposta velha não conta como resposta deste turno', async () => {
  const { tmux } = tmuxFalso({ viva: true })
  let voltas = 0
  const runAttached = createAttachedRunner({
    tmux,
    readReply: async () => { voltas += 1; return { content: 'resposta velha', timestamp: '1' } },
    now: (() => { let t = 0; return () => (t += 30000) })(),
    sleep: async () => {},
  })

  const r = await runAttached({ ...base, timeoutMs: 120000 })
  assert.equal(r.ok, false)
  assert.match(r.error, /tempo limite/)
  assert.ok(voltas > 1)
})

test('espera a conversa sossegar antes de dar a resposta por pronta', async () => {
  const { tmux } = tmuxFalso({ viva: true })
  const runAttached = createAttachedRunner({
    tmux,
    // Claude escreve uma mensagem, depois outra: a boa é a última.
    readReply: transcricao([
      null,
      { content: 'primeira parte', timestamp: '2' },
      { content: 'resposta final', timestamp: '3' },
      { content: 'resposta final', timestamp: '3' },
    ]),
    now: (() => { let t = 0; return () => (t += 7000) })(),
    sleep: async () => {},
  })

  const r = await runAttached({ ...base })
  assert.equal(r.text, 'resposta final')
})

test('sem tmux, com id estranho, ou sem conseguir digitar: falha dizendo o motivo', async () => {
  const semTmux = createAttachedRunner({ tmux: tmuxFalso({ disponivel: false }).tmux, sleep: async () => {} })
  assert.match((await semTmux({ ...base })).error, /tmux não está instalado/)

  const runAttached = createAttachedRunner({ tmux: tmuxFalso({ viva: true }).tmux, sleep: async () => {} })
  assert.match((await runAttached({ ...base, agentId: 'id; rm -rf /' })).error, /id de sessão estranho/)
  assert.match((await runAttached({ ...base, sessionId: null })).error, /faltou o id da conversa/)

  const semDigitar = tmuxFalso({ viva: true, digitarOk: false })
  const falhando = createAttachedRunner({ tmux: semDigitar.tmux, readReply: async () => null, sleep: async () => {} })
  const r = await falhando({ ...base })
  assert.match(r.error, /não consegui digitar/)
  assert.ok(semDigitar.chamadas.some((c) => c[0] === 'matar'), 'e fecha a janela quebrada')
})

test('avisa que está demorando e mantém a batida', async () => {
  const { tmux } = tmuxFalso({ viva: true })
  const avisos = []
  let lento = 0
  const runAttached = createAttachedRunner({
    tmux,
    readReply: transcricao([null, null, null, { content: 'fim', timestamp: '5' }, { content: 'fim', timestamp: '5' }]),
    now: (() => { let t = 0; return () => (t += 20000) })(),
    sleep: async () => {},
  })

  const r = await runAttached({ ...base, slowNoticeMs: 10000, heartbeatMs: 30000, onSlow: () => { lento += 1 }, onNotice: (t) => avisos.push(t) })
  assert.equal(r.ok, true)
  assert.equal(lento, 1, 'avisa uma vez só que está demorando')
  assert.ok(avisos.every((a) => /Ainda trabalhando/.test(a)))
})

test('createTmux cola o texto com bracketed paste, sem deixar a quebra de linha enviar sozinha', async () => {
  const comandos = []
  const exec = (bin, args, opts, cb) => {
    comandos.push(args)
    const filho = { stdin: { end: () => {} } }
    setImmediate(() => cb(null, '', ''))
    return filho
  }
  const tmux = createTmux({ exec })
  await tmux.digitar('wpp-infra', 'primeira linha\nsegunda linha')

  assert.deepEqual(comandos[0].slice(0, 3), ['load-buffer', '-b', 'wpp-wpp-infra'])
  assert.ok(comandos[1].includes('paste-buffer') && comandos[1].includes('-p'), 'bracketed paste')
  assert.deepEqual(comandos[2], ['send-keys', '-t', 'wpp-infra', 'Enter'])
})
