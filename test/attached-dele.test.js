import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAttachedRunner, descobrirSessao } from '../src/attached.js'

// A session he started in his own terminal has no entry in `claude agents`,
// so there is no id to attach to: the window opens the conversation itself.
function tmuxFalso({ viva = false } = {}) {
  const chamadas = []
  return {
    chamadas,
    tmux: {
      disponivel: async () => true,
      viva: async () => viva,
      abrir: async (n, cmd, cwd) => { chamadas.push(['abrir', n, cmd, cwd]); return { ok: true, stderr: '' } },
      digitar: async (n, texto) => { chamadas.push(['digitar', n, texto]); return { ok: true, stderr: '' } },
      matar: async (n) => { chamadas.push(['matar', n]); return { ok: true } },
    },
  }
}

function transcricao(sequencia) {
  let i = 0
  return async () => sequencia[Math.min(i++, sequencia.length - 1)]
}

const base = { nome: 'infra', cwd: '/tmp', agentId: null, sessionId: 'sid-dele', prompt: 'roda os testes' }

test('sem id de agente: abre a conversa dele e acha onde ela continuou', async () => {
  const { tmux, chamadas } = tmuxFalso()
  const runAttached = createAttachedRunner({
    tmux,
    bin: 'claude',
    readReply: transcricao([null, { content: 'feito', timestamp: '4' }, { content: 'feito', timestamp: '4' }]),
    descobrir: async ({ anterior }) => (anterior === 'sid-dele' ? 'sid-novo' : null),
    now: (() => { let t = 0; return () => (t += 7000) })(),
    sleep: async () => {},
  })

  const r = await runAttached({ ...base })
  assert.equal(r.ok, true)
  // A resposta vem da conversa nova, e é esse id que o handler passa a guardar.
  assert.equal(r.sessionId, 'sid-novo')
  assert.equal(r.abriu, true)
  assert.deepEqual(chamadas.find((c) => c[0] === 'abrir'),
    ['abrir', 'wpp-infra', 'claude --resume sid-dele --dangerously-skip-permissions', '/tmp'])
})

test('não achar a conversa nova fecha a janela e deixa cair para a via normal', async () => {
  const { tmux, chamadas } = tmuxFalso()
  const runAttached = createAttachedRunner({
    tmux,
    descobrir: async () => null,
    readReply: async () => null,
    sleep: async () => {},
  })

  const r = await runAttached({ ...base })
  assert.equal(r.ok, false)
  assert.equal(r.podeCair, true, 'a mensagem não chegou nela: ainda dá para ir pela via antiga')
  assert.match(r.error, /não achei onde ela continuou/)
  assert.ok(chamadas.some((c) => c[0] === 'matar'))
})

test('janela já viva não reabre nem procura conversa nova', async () => {
  const { tmux, chamadas } = tmuxFalso({ viva: true })
  let procurou = 0
  const runAttached = createAttachedRunner({
    tmux,
    descobrir: async () => { procurou += 1; return 'outra' },
    readReply: transcricao([null, { content: 'ok', timestamp: '2' }, { content: 'ok', timestamp: '2' }]),
    now: (() => { let t = 0; return () => (t += 7000) })(),
    sleep: async () => {},
  })

  const r = await runAttached({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'sid-dele')
  assert.equal(procurou, 0)
  assert.ok(!chamadas.some((c) => c[0] === 'abrir'))
})

test('id de conversa estranho não vira comando', async () => {
  const runAttached = createAttachedRunner({ tmux: tmuxFalso({ viva: true }).tmux, sleep: async () => {} })
  const r = await runAttached({ ...base, sessionId: 'sid; rm -rf /' })
  assert.equal(r.ok, false)
  assert.match(r.error, /id de conversa estranho/)
})

test('descobrirSessao pega a transcrição que apareceu depois, ignorando a antiga', async () => {
  const mtimes = { 'sid-dele.jsonl': 500, 'sid-novo.jsonl': 900, 'velha.jsonl': 100 }
  const achado = await descobrirSessao({
    cwd: '/tmp',
    anterior: 'sid-dele',
    desde: 400,
    listar: async () => ['sid-dele.jsonl', 'sid-novo.jsonl', 'velha.jsonl', 'nao-e-transcricao.txt'],
    medir: async (caminho) => ({ mtimeMs: mtimes[caminho.split('/').pop()] ?? 0 }),
  })
  assert.equal(achado, 'sid-novo')
})
