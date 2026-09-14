import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDeck, lerRecibo, execCli } from '../src/deck.js'

const RECIBO_OK = JSON.stringify({ delivery: 'submitted', submitted: true, success: true, session_title: 'dw' }, null, 2)

// Answers each CLI call from a table keyed by the first arguments, and records
// every call so a test can check what the adapter actually asked for.
function montar({ respostas = {}, relogio = 1_000_000 } = {}) {
  const chamadas = []
  let agora = relogio
  const runCli = async (bin, args, opts = {}) => {
    chamadas.push({ bin, args, opts })
    const chave = bin === 'tmux' ? `tmux ${args[0]}` : args.slice(0, 2).join(' ')
    const r = respostas[chave]
    const v = typeof r === 'function' ? await r(args, opts) : r
    return v ?? { code: 0, stdout: '', stderr: '' }
  }
  const deck = createDeck({ runCli, sleep: async () => { agora += 500 }, now: () => agora })
  return { deck, chamadas, avancar: (ms) => { agora += ms } }
}

function saida(content, timestamp) {
  return { code: 0, stdout: JSON.stringify({ content, timestamp, success: true, role: 'assistant' }), stderr: '' }
}

test('lê o recibo mesmo com a resposta em texto colada depois dele', () => {
  const r = lerRecibo(`${RECIBO_OK}\npong\n`)
  assert.equal(r.success, true)
  assert.equal(r.delivery, 'submitted')
})

test('recibo com chave dentro de string não confunde a leitura', () => {
  const bruto = JSON.stringify({ success: false, error: 'texto com } e { dentro' }, null, 2)
  assert.equal(lerRecibo(`${bruto}\nresto`).error, 'texto com } e { dentro')
})

test('sem recibo devolve null em vez de inventar sucesso', () => {
  assert.equal(lerRecibo('só texto, sem json'), null)
  assert.equal(lerRecibo(''), null)
})

test('manda o prompt pelo stdin, nunca como argumento', async () => {
  const { deck, chamadas } = montar({
    respostas: {
      'session show': { code: 0, stdout: JSON.stringify({ status: 'waiting' }) },
      'session send': { code: 0, stdout: `${RECIBO_OK}\nok` },
      'session output': saida('feito', new Date(2_000_000).toISOString()),
    },
  })
  await deck.run({ name: 'dw', prompt: 'segredo; rm -rf ~' })
  const send = chamadas.find((c) => c.args[1] === 'send')
  assert.equal(send.opts.stdin, 'segredo; rm -rf ~')
  assert.ok(!send.args.includes('segredo; rm -rf ~'))
  assert.ok(send.args.includes('--defer-if-busy'))
  assert.ok(send.args.includes('--wait'))
})

test('devolve a resposta lida do output e marca como entregue', async () => {
  const ts = new Date(2_000_000).toISOString()
  const { deck } = montar({
    respostas: {
      'session show': { code: 0, stdout: JSON.stringify({ status: 'waiting' }) },
      'session send': { code: 0, stdout: `${RECIBO_OK}\npong` },
      'session output': saida('pong', ts),
    },
  })
  const r = await deck.run({ name: 'dw', prompt: 'ping' })
  assert.deepEqual(r, { ok: true, text: 'pong', sessionId: null, error: null })
  assert.equal(deck.delivered.get('dw'), ts)
})

test('entrega que falha vira erro com o motivo do agent-deck', async () => {
  const recibo = JSON.stringify({ success: false, error: 'send dropped silently' }, null, 2)
  const { deck } = montar({
    respostas: {
      'session show': { code: 0, stdout: JSON.stringify({ status: 'waiting' }) },
      'session send': { code: 1, stdout: recibo },
    },
  })
  const r = await deck.run({ name: 'dw', prompt: 'oi' })
  assert.equal(r.ok, false)
  assert.match(r.error, /não entreguei para dw: send dropped silently/)
})

test('resposta mais velha que o pedido não é devolvida como se fosse nova', async () => {
  const { deck } = montar({
    relogio: 5_000_000,
    respostas: {
      'session show': { code: 0, stdout: JSON.stringify({ status: 'waiting' }) },
      'session send': { code: 0, stdout: RECIBO_OK },
      'session output': saida('resposta antiga', new Date(1_000).toISOString()),
    },
  })
  const r = await deck.run({ name: 'dw', prompt: 'oi' })
  assert.equal(r.ok, false)
  assert.match(r.error, /terminou sem responder/)
})

// What Claude's pane shows while a tool waits for approval. agent-deck reports
// this as `waiting`, the same status as a finished turn.
const TELA_PERMISSAO = [
  'Bash command',
  "  python3 -c 'print(123)'",
  ' Permission rule Bash(python3 *) requires confirmation for this command.',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  ' Esc to cancel · Tab to amend',
].join('\n')
const TELA_LIVRE = '❯ \n  ⏵⏵ bypass permissions on (shift+tab to cycle)'

test('sessão parada num pedido de permissão não recebe a mensagem: o Enter dela aprovaria o pedido', async () => {
  const { deck, chamadas } = montar({
    respostas: {
      'session show': { code: 0, stdout: JSON.stringify({ status: 'waiting', tmux_session: 'agentdeck_cw' }) },
      'tmux capture-pane': { code: 0, stdout: TELA_PERMISSAO, stderr: '' },
    },
  })
  const r = await deck.run({ name: 'cw', prompt: 'oi' })
  assert.equal(r.ok, false)
  assert.match(r.error, /pedido de permissão/)
  assert.match(r.error, /não enviei/i)
  assert.equal(chamadas.find((c) => c.args[1] === 'send'), undefined)
})

test('send que volta cedo por causa de um pedido de permissão espera o turno terminar de verdade', async () => {
  // The send lands, the turn then asks for approval, and `send --wait` returns
  // with the previous reply. Approval comes later and the real answer follows.
  let fase = 'livre'
  const avisos = []
  const { deck, avancar } = montar({
    relogio: 5_000_000,
    respostas: {
      'session show': () => ({
        code: 0,
        stdout: JSON.stringify({ status: fase === 'trabalhando' ? 'running' : 'waiting', tmux_session: 'agentdeck_cw' }),
      }),
      'tmux capture-pane': () => {
        // Approval arrives while the bot is polling; then the turn runs to the end.
        if (fase === 'permissao' && avisos.length) fase = 'trabalhando'
        else if (fase === 'trabalhando') fase = 'fim'
        return { code: 0, stdout: fase === 'permissao' ? TELA_PERMISSAO : TELA_LIVRE, stderr: '' }
      },
      'session send': () => { fase = 'permissao'; return { code: 0, stdout: RECIBO_OK, stderr: 'Warning: output freshness timeout (5s) — response may be stale' } },
      'session output': () => (fase === 'fim'
        ? saida('subi para a main', new Date(9_000_000).toISOString())
        : saida('resposta do turno anterior', new Date(1_000).toISOString())),
    },
  })
  const r = await deck.run({ name: 'cw', prompt: 'pode subir', onNotice: (t) => { avisos.push(t); avancar(1000) } })
  assert.deepEqual(r, { ok: true, text: 'subi para a main', sessionId: null, error: null })
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /pedido de permissão/)
})

test('sessão no meio de um turno: espera o turno acabar antes de mandar, e avisa que está esperando', async () => {
  let consultas = 0
  let enviadoComStatus = null
  let status = 'running'
  const avisos = []
  const { deck } = montar({
    relogio: 5_000_000,
    respostas: {
      'session show': () => {
        consultas += 1
        if (consultas > 3) status = 'waiting'
        return { code: 0, stdout: JSON.stringify({ status, tmux_session: 'agentdeck_cw' }) }
      },
      'tmux capture-pane': { code: 0, stdout: TELA_LIVRE, stderr: '' },
      'session send': () => { enviadoComStatus = status; return { code: 0, stdout: RECIBO_OK } },
      'session output': saida('pronto', new Date(9_000_000).toISOString()),
    },
  })
  const r = await deck.run({ name: 'cw', prompt: 'oi', onNotice: (t) => avisos.push(t) })
  assert.equal(r.ok, true)
  assert.equal(enviadoComStatus, 'waiting')
  assert.equal(avisos.length, 1)
  assert.match(avisos[0], /turno atual/)
})

test('interromper também manda Escape para o pane, não só para de esperar', async () => {
  const controle = new AbortController()
  const { deck, chamadas } = montar({
    respostas: {
      'session show': { code: 0, stdout: JSON.stringify({ status: 'waiting', tmux_session: 'agentdeck_dw' }) },
      'session send': async () => { controle.abort(); return { code: null, stdout: '', stderr: '', aborted: true } },
    },
  })
  const r = await deck.run({ name: 'dw', prompt: 'longo', signal: controle.signal })
  assert.equal(r.error, 'Interrompido.')
  const esc = chamadas.find((c) => c.bin === 'tmux' && c.args[0] === 'send-keys')
  assert.deepEqual(esc.args, ['send-keys', '-t', 'agentdeck_dw', 'Escape'])
})

test('sessão parada é religada antes de receber a mensagem', async () => {
  const { deck, chamadas } = montar({
    respostas: {
      'session show': { code: 0, stdout: JSON.stringify({ status: 'stopped', tmux_session: 'p' }) },
      'tmux capture-pane': { code: 0, stdout: '⏵⏵ bypass permissions on' },
      'session send': { code: 0, stdout: RECIBO_OK },
      'session output': saida('voltei', new Date(2_000_000).toISOString()),
    },
  })
  const r = await deck.run({ name: 'dw', prompt: 'oi' })
  assert.equal(r.ok, true)
  const ordem = chamadas.filter((c) => c.bin !== 'tmux').map((c) => c.args[1])
  assert.ok(ordem.indexOf('start') < ordem.indexOf('send'))
})

test('criar sessão abre como raiz, no grupo pedido', async () => {
  const { deck, chamadas } = montar({
    respostas: {
      'launch /tmp/x': { code: 0, stdout: JSON.stringify({ success: true }) },
      'session show': { code: 0, stdout: JSON.stringify({ tmux_session: 'p' }) },
      'tmux capture-pane': { code: 0, stdout: '? for shortcuts' },
    },
  })
  await deck.create({ cwd: '/tmp/x', name: 'api', group: 'whatsapp' })
  const launch = chamadas.find((c) => c.args[0] === 'launch')
  assert.ok(launch.args.includes('-no-parent'))
  assert.deepEqual(launch.args.slice(launch.args.indexOf('-g'), launch.args.indexOf('-g') + 2), ['-g', 'whatsapp'])
  assert.deepEqual(launch.args.slice(launch.args.indexOf('-t'), launch.args.indexOf('-t') + 2), ['-t', 'api'])
})

test('pasta nova: aceita a confiança em vez de deixar o "No, exit" sob o cursor', async () => {
  let telas = ['Is this a project you trust?\n❯ No, exit\n  Yes, I trust this folder', '⏵⏵ bypass permissions on']
  const { deck, chamadas } = montar({
    respostas: {
      'launch /tmp/novo': { code: 0, stdout: JSON.stringify({ success: true }) },
      'session show': { code: 0, stdout: JSON.stringify({ tmux_session: 'p' }) },
      'tmux capture-pane': () => ({ code: 0, stdout: telas.length > 1 ? telas.shift() : telas[0] }),
    },
  })
  await deck.create({ cwd: '/tmp/novo', name: 'novo' })
  const teclas = chamadas.filter((c) => c.bin === 'tmux' && c.args[0] === 'send-keys').map((c) => c.args.at(-1))
  assert.deepEqual(teclas, ['Down', 'Enter'])
})

test('criar que falha no agent-deck vira erro legível', async () => {
  const { deck } = montar({
    respostas: { 'launch /tmp/x': { code: 1, stdout: '', stderr: 'path does not exist' } },
  })
  await assert.rejects(deck.create({ cwd: '/tmp/x', name: 'api' }), /não consegui criar api: path does not exist/)
})

test('lista ignora sessões arquivadas e normaliza os campos', async () => {
  const { deck } = montar({
    respostas: {
      'list --json': {
        code: 0,
        stdout: JSON.stringify([
          { id: 'a', title: 'conductor-dw', status: 'waiting', group: 'conductor', path: '/c/dw', last_activity_at: 't1' },
          { id: 'b', title: 'daily-sync', status: 'running', path: '/p', parent_session_id: 'a' },
          { id: 'c', title: 'velha', status: 'idle', path: '/v', archived: true },
        ]),
      },
    },
  })
  const lista = await deck.list()
  assert.deepEqual(lista.map((s) => s.title), ['conductor-dw', 'daily-sync'])
  assert.equal(lista[1].parentId, 'a')
  assert.equal(lista[0].lastActivityAt, 't1')
})

test('detect responde false quando o binário não existe', async () => {
  const deck = createDeck({ bin: '/caminho/que/nao/existe/agent-deck' })
  assert.equal(await deck.detect(), false)
})

test('execCli entrega o stdin e respeita o timeout', async () => {
  const eco = await execCli('sh', ['-c', 'cat'], { stdin: 'olá\nmundo' })
  assert.equal(eco.stdout, 'olá\nmundo')
  const lento = await execCli('sh', ['-c', 'sleep 5'], { timeoutMs: 100 })
  assert.equal(lento.timedOut, true)
})

test('conflito de concorrência do agent-deck ao religar é tentado de novo', async () => {
  let tentativas = 0
  const { deck } = montar({
    respostas: {
      'session start': () => {
        tentativas += 1
        return tentativas < 3
          ? { code: 1, stderr: 'failed to save instances: stale concurrent Status conflict for instance x' }
          : { code: 0, stdout: '' }
      },
      'session show': { code: 0, stdout: JSON.stringify({ status: 'stopped', tmux_session: 'p' }) },
      'tmux capture-pane': { code: 0, stdout: '? for shortcuts' },
    },
  })
  await deck.start('dw')
  assert.equal(tentativas, 3)
})

test('religar não repete o start se a tentativa anterior já tinha religado', async () => {
  let tentativas = 0
  const { deck } = montar({
    respostas: {
      'session start': () => { tentativas += 1; return { code: 1, stderr: 'stale concurrent Status conflict' } },
      'session show': { code: 0, stdout: JSON.stringify({ status: 'waiting', tmux_session: 'p' }) },
      'tmux capture-pane': { code: 0, stdout: '? for shortcuts' },
    },
  })
  await deck.start('dw')
  assert.equal(tentativas, 1)
})

test('outro erro ao religar não é repetido às cegas', async () => {
  let tentativas = 0
  const { deck } = montar({
    respostas: {
      'session start': () => { tentativas += 1; return { code: 1, stderr: 'session not found' } },
    },
  })
  await assert.rejects(deck.start('dw'), /não consegui religar dw: session not found/)
  assert.equal(tentativas, 1)
})

test('conflito que não passa desiste depois de poucas tentativas', async () => {
  let tentativas = 0
  const { deck } = montar({
    respostas: {
      'session start': () => { tentativas += 1; return { code: 1, stderr: 'stale concurrent Status conflict' } },
      'session show': { code: 0, stdout: JSON.stringify({ status: 'stopped' }) },
    },
  })
  await assert.rejects(deck.start('dw'), /stale concurrent/)
  assert.equal(tentativas, 4)
})
