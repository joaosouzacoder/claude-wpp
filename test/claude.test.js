import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaude, parseBgId } from '../src/claude.js'

const BG_OUT = (id, name) => `backgrounded · \x1b[36m${id}\x1b[39m${name ? ` · ${name}` : ''}\n  claude agents  list sessions\n`

// Answers each CLI call from a table keyed by the first argument(s), and
// records every call so a test can check what run() actually asked for.
function montar({ respostas = {}, relogio = 1_000_000, trust, readReply } = {}) {
  const chamadas = []
  let agora = relogio
  const runCli = async (bin, args, opts = {}) => {
    chamadas.push({ bin, args, opts })
    const chave = args[0]
    const r = respostas[chave]
    const v = typeof r === 'function' ? await r(args, opts, chamadas) : r
    return v ?? { code: 0, stdout: '', stderr: '' }
  }
  const claude = createClaude({
    runCli,
    trust: trust ?? (() => {}),
    readReply: readReply ?? (() => null),
    sleep: async () => { agora += 500 },
    now: () => agora,
  })
  return { claude, chamadas, avancar: (ms) => { agora += ms } }
}

const base = { cwd: '/tmp/algum', prompt: 'oi', slowNoticeMs: 50, timeoutMs: 5000 }

test('parseBgId lê o id apesar da cor ANSI', () => {
  assert.equal(parseBgId(BG_OUT('03c3d989', 'api')), '03c3d989')
  assert.equal(parseBgId('nada aqui'), null)
})

test('sessão nova confia no diretório, dispara sem --resume e devolve o sessionId da lista', async () => {
  const confiadas = []
  const { claude, chamadas } = montar({
    trust: (cwd) => confiadas.push(cwd),
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345', 'api') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'full-uuid-1', status: 'idle' }]) },
    },
    readReply: () => ({ content: 'pronto', timestamp: new Date(2_000_000).toISOString() }),
  })

  const r = await claude.run({ ...base })
  assert.deepEqual(r, { ok: true, text: 'pronto', sessionId: 'full-uuid-1', error: null })
  assert.deepEqual(confiadas, ['/tmp/algum'])

  const disparo = chamadas.find((c) => c.args[0] === '--bg')
  assert.deepEqual(disparo.args, ['--bg', '--dangerously-skip-permissions', 'oi'])
})

test('sessão existente passa --resume com o id e não confia de novo no diretório', async () => {
  const confiadas = []
  const { claude, chamadas } = montar({
    trust: (cwd) => confiadas.push(cwd),
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-antigo', status: 'idle' }]) },
    },
    readReply: () => ({ content: 'ok', timestamp: new Date(2_000_000).toISOString() }),
  })

  await claude.run({ ...base, name: 'api', sessionId: 'sid-antigo' })
  assert.deepEqual(confiadas, [])

  const disparo = chamadas.find((c) => c.args[0] === '--bg')
  assert.deepEqual(disparo.args, ['--bg', '--dangerously-skip-permissions', '-n', 'api', '--resume', 'sid-antigo', 'oi'])
})

// A copy of a session that is busy elsewhere has been seen getting stuck
// forever (`state: blocked`) if that turn had a background shell command
// pending — a bug in claude itself, not something this code can fix. Refusing
// up front is the mitigation.
test('recusa --resume numa sessão que já está rodando de verdade em outro lugar', async () => {
  const { claude, chamadas } = montar({
    respostas: {
      agents: { code: 0, stdout: JSON.stringify([{ id: 'outro-id', sessionId: 'sid-em-uso', status: 'busy' }]) },
    },
  })

  const r = await claude.run({ ...base, sessionId: 'sid-em-uso' })
  assert.equal(r.ok, false)
  assert.match(r.error, /ocupada/)
  assert.ok(!chamadas.some((c) => c.args[0] === '--bg'), 'não deveria nem tentar disparar')
})

test('sessão existente que está idle em outro lugar dispara normalmente', async () => {
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'outro-id', sessionId: 'sid-livre', status: 'idle' }]) },
    },
    readReply: () => ({ content: 'ok', timestamp: new Date(2_000_000).toISOString() }),
  })
  const r = await claude.run({ ...base, sessionId: 'sid-livre' })
  assert.equal(r.ok, true)
})

test('espera enquanto a sessão está busy e só lê a resposta quando termina', async () => {
  let checagens = 0
  const { claude, chamadas } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: () => {
        checagens += 1
        const status = checagens < 3 ? 'busy' : 'idle'
        return { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status }]) }
      },
    },
    readReply: () => ({ content: 'demorei mas cheguei', timestamp: new Date(2_000_000).toISOString() }),
  })

  const r = await claude.run({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'demorei mas cheguei')
  assert.ok(checagens >= 3)
  assert.equal(chamadas.filter((c) => c.args[0] === 'agents').length, checagens)
})

test('resposta mais velha que o pedido vira erro em vez de parecer nova', async () => {
  const { claude } = montar({
    relogio: 5_000_000,
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle' }]) },
    },
    readReply: () => ({ content: 'resposta velha', timestamp: new Date(1_000_000).toISOString() }),
  })

  const r = await claude.run({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /terminou sem responder em texto/)
})

test('sem nenhuma resposta gravada, erro diz que não conseguiu ler', async () => {
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle' }]) },
    },
    readReply: () => null,
  })

  const r = await claude.run({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /não consegui ler a resposta/)
})

test('bloqueado avisa uma vez só e continua esperando até responder', async () => {
  let checagens = 0
  let avisos = 0
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: () => {
        checagens += 1
        const bloqueado = checagens < 5
        return {
          code: 0,
          stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle', state: bloqueado ? 'blocked' : 'done' }]),
        }
      },
    },
    readReply: () => ({ content: 'liberou', timestamp: new Date(2_000_000).toISOString() }),
  })

  const r = await claude.run({ ...base, onNotice: () => { avisos += 1 } })
  assert.equal(r.ok, true)
  assert.equal(avisos, 1)
})

test('a sessão some da lista antes de responder: erro, não trava', async () => {
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([]) },
    },
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, false)
})

test('disparo com exit diferente de zero vira erro com o stderr', async () => {
  const { claude } = montar({
    respostas: { '--bg': { code: 1, stdout: '', stderr: 'algo deu errado' } },
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /algo deu errado/)
})

test('saída de disparo sem o id esperado vira erro legível', async () => {
  const { claude } = montar({
    respostas: { '--bg': { code: 0, stdout: 'isso não é o que eu esperava' } },
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /não entendi/)
})

test('disparo que não confirma a tempo vira erro', async () => {
  const { claude } = montar({
    respostas: { '--bg': { code: null, stdout: '', stderr: '', timedOut: true } },
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, false)
  assert.match(r.error, /não confirmou/)
})

test('abort chama stop com o id certo e devolve interrompido', async () => {
  const paradas = []
  const removidas = []
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'busy' }]) },
      stop: (args) => { paradas.push(args[1]); return { code: 0 } },
      rm: (args) => { removidas.push(args[1]); return { code: 0 } },
    },
  })
  const ac = new AbortController()
  const promessa = claude.run({ ...base, signal: ac.signal })
  // A resolução chega no próximo tick da fila de microtarefas do runCli fake;
  // abortar já no início do loop é o que este teste quer observar.
  await Promise.resolve()
  ac.abort()
  const r = await promessa
  assert.equal(r.ok, false)
  assert.match(r.error, /interrompid/i)
  assert.ok(paradas.every((id) => id === 'abc12345') && paradas.length >= 1)
  // Interromper não deixa a sessão pendurada esperando ninguém: ela some do
  // `claude agents` do mesmo jeito que uma sessão que respondeu normalmente.
  assert.deepEqual(removidas, ['abc12345'])
})

test('abort chegado durante o disparo ainda para a sessão assim que o id é conhecido', async () => {
  const paradas = []
  const ac = new AbortController()
  const { claude } = montar({
    respostas: {
      '--bg': async () => { ac.abort(); return { code: 0, stdout: BG_OUT('abc12345') } },
      stop: (args) => { paradas.push(args[1]); return { code: 0 } },
    },
  })
  const r = await claude.run({ ...base, signal: ac.signal })
  assert.equal(r.ok, false)
  assert.match(r.error, /interrompid/i)
  assert.ok(paradas.every((id) => id === 'abc12345') && paradas.length >= 1)
})

test('timeoutMs excedido chama stop e devolve erro de tempo limite', async () => {
  const paradas = []
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'busy' }]) },
      stop: (args) => { paradas.push(args[1]); return { code: 0 } },
    },
  })
  const r = await claude.run({ ...base, timeoutMs: 100 })
  assert.equal(r.ok, false)
  assert.match(r.error, /tempo/i)
  assert.ok(paradas.every((id) => id === 'abc12345') && paradas.length >= 1)
})

test('sessão que termina normalmente é removida do claude agents, não fica pendurada', async () => {
  const removidas = []
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle' }]) },
      rm: (args) => { removidas.push(args[1]); return { code: 0 } },
    },
    readReply: () => ({ content: 'pronto', timestamp: new Date(2_000_000).toISOString() }),
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, true)
  assert.deepEqual(removidas, ['abc12345'])
})

test('dispara onSlow enquanto o run demora de verdade', async () => {
  const claude = createClaude({
    runCli: async (bin, args) => {
      if (args[0] === '--bg') return { code: 0, stdout: BG_OUT('abc12345') }
      await new Promise((r) => setTimeout(r, 15))
      return { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle' }]) }
    },
    trust: () => {},
    readReply: () => ({ content: 'ok', timestamp: new Date().toISOString() }),
    sleep: () => Promise.resolve(),
  })
  let chamadas = 0
  const r = await claude.run({ ...base, slowNoticeMs: 20, onSlow: () => { chamadas += 1 } })
  assert.equal(r.ok, true)
  assert.equal(chamadas, 1)
})

test('com heartbeatMs, onSlow repete enquanto a sessão segue busy', async () => {
  let checagens = 0
  const claude = createClaude({
    runCli: async (bin, args) => {
      if (args[0] === '--bg') return { code: 0, stdout: BG_OUT('abc12345') }
      checagens += 1
      await new Promise((r) => setTimeout(r, 15))
      return { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: checagens < 6 ? 'busy' : 'idle' }]) }
    },
    trust: () => {},
    readReply: () => ({ content: 'ok', timestamp: new Date().toISOString() }),
    sleep: () => Promise.resolve(),
  })
  const marcas = []
  const r = await claude.run({ ...base, slowNoticeMs: 20, heartbeatMs: 30, onSlow: (ms) => marcas.push(ms) })
  assert.equal(r.ok, true)
  assert.ok(marcas.length >= 2, `esperava vários avisos, vieram ${marcas.length}`)
})
