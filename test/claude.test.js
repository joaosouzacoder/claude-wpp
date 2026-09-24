import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClaude, parseBgId } from '../src/claude.js'

const BG_OUT = (id, name) => `backgrounded · \x1b[36m${id}\x1b[39m${name ? ` · ${name}` : ''}\n  claude agents  list sessions\n`

// Answers each CLI call from a table keyed by the first argument(s), and
// records every call so a test can check what run() actually asked for.
// sleepReal lets a test spend a sliver of *actual* wall-clock time per poll
// (on top of the fake clock's own advance) so real setTimeout/setInterval
// timers — slowNoticeMs, heartbeatMs — get a genuine chance to fire during
// the test instead of racing the instantly-resolving fake sleep.
function montar({ respostas = {}, relogio = 1_000_000, trust, readReply, sleepMs = 500, sleepReal = 0 } = {}) {
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
    sleep: async () => {
      agora += sleepMs
      if (sleepReal) await new Promise((r) => setTimeout(r, sleepReal))
    },
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

test('appendSystemPrompt vira --append-system-prompt quando informado', async () => {
  const { claude, chamadas } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle' }]) },
    },
    readReply: () => ({ content: 'ok', timestamp: new Date(2_000_000).toISOString() }),
  })
  await claude.run({ ...base, appendSystemPrompt: 'formata pro whatsapp' })
  const disparo = chamadas.find((c) => c.args[0] === '--bg')
  assert.deepEqual(disparo.args, ['--bg', '--dangerously-skip-permissions', '--append-system-prompt', 'formata pro whatsapp', 'oi'])
})

test('sem appendSystemPrompt, a flag nem aparece', async () => {
  const { claude, chamadas } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle' }]) },
    },
    readReply: () => ({ content: 'ok', timestamp: new Date(2_000_000).toISOString() }),
  })
  await claude.run({ ...base })
  const disparo = chamadas.find((c) => c.args[0] === '--bg')
  assert.ok(!disparo.args.includes('--append-system-prompt'))
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

// Visto em produção: claude agents já dava a sessão como terminada antes do
// arquivo do transcript existir de fato no disco — a primeira leitura chegava
// cedo demais e perdia uma resposta real.
test('resposta demora a aparecer no disco: tenta de novo antes de desistir', async () => {
  let tentativas = 0
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle' }]) },
    },
    readReply: () => {
      tentativas += 1
      return tentativas < 3 ? null : { content: 'cheguei atrasada', timestamp: new Date(2_000_000).toISOString() }
    },
  })

  const r = await claude.run({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'cheguei atrasada')
  assert.equal(tentativas, 3)
})

// Visto ao vivo em produção: uma sessão respondeu de verdade (Stop hooks
// rodaram, resposta gravada no transcript) e `claude agents --json` continuou
// dizendo `state: "blocked"` para sempre depois disso — o campo nunca voltou.
// Sem checar a resposta antes de acreditar em `blocked`, essa resposta nunca
// chegava no WhatsApp.
test('estado diz blocked pra sempre, mas já tem resposta pronta: entrega em vez de esperar', async () => {
  let avisos = 0
  const { claude } = montar({
    relogio: 1_000_000,
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle', state: 'blocked' }]) },
    },
    readReply: () => ({ content: 'Oi! Tô por aqui.', timestamp: new Date(2_000_000).toISOString() }),
  })

  const r = await claude.run({ ...base, onNotice: () => { avisos += 1 } })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'Oi! Tô por aqui.')
  assert.equal(avisos, 0, 'não devia nem avisar que travou, já que na verdade respondeu')
})

// Visto ao vivo: um --resume cujo alvo o claude não achou reportou
// state: "failed" — mas por baixo a sessão tinha rodado do zero e respondido
// normalmente. A mesma checagem de blocked se aplica aqui.
test('state failed também entrega se já tiver resposta pronta', async () => {
  const { claude } = montar({
    relogio: 1_000_000,
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', state: 'failed' }]) },
    },
    readReply: () => ({ content: 'Oi! Tudo certo.', timestamp: new Date(2_000_000).toISOString() }),
  })

  const r = await claude.run({ ...base, sessionId: 'sid-antigo' })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'Oi! Tudo certo.')
})

test('state failed sem resposta nenhuma, resumindo sessão antiga: falha rápido e marca o id como morto', async () => {
  let checagens = 0
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: () => { checagens += 1; return { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', state: 'failed' }]) } },
    },
    readReply: () => null,
  })

  const r = await claude.run({ ...base, sessionId: 'sid-antigo' })
  assert.equal(r.ok, false)
  assert.match(r.error, /failed/)
  assert.equal(r.sessionBroken, true, 'o alvo do --resume está provadamente morto')
  // 1 checagem do busy-precheck (por causa do --resume) + 1 do próprio loop de
  // poll — não chega a esperar as três olhadas quietas de OLHADAS_QUIETAS,
  // porque failed não se resolve sozinho como um "ainda ocupado" comum.
  assert.equal(checagens, 2)
})

test('state failed numa sessão nova (sem --resume) não marca nada como morto: não havia id pra matar', async () => {
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-novo', state: 'failed' }]) },
    },
    readReply: () => null,
  })

  const r = await claude.run({ ...base })
  assert.equal(r.ok, false)
  assert.ok(!r.sessionBroken)
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
    // Nada pronto ainda enquanto realmente travada — só depois que o estado
    // vira 'done' de verdade é que existe uma resposta a ler.
    readReply: () => (checagens >= 5 ? { content: 'liberou', timestamp: new Date(2_000_000).toISOString() } : null),
  })

  const r = await claude.run({ ...base, onNotice: () => { avisos += 1 } })
  assert.equal(r.ok, true)
  assert.equal(avisos, 1)
})

// blocked é um bug conhecido do claude, sem saída própria — sem teto, o
// heartbeat original repetia "Ainda trabalhando nisso" a cada heartbeatMs pra
// sempre (foi assim que uma sessão real ficou 6h mandando esse aviso). O
// sleep aqui gasta um pouquinho de tempo real de propósito, pra dar chance
// dos timers reais de slowNoticeMs/heartbeatMs disparar durante o teste.
test('bloqueado nunca repete "ainda trabalhando" e cancela sozinho ao passar do teto', async () => {
  let avisosSlow = 0
  let avisosNotice = 0
  const { claude, chamadas } = montar({
    sleepMs: 5,
    sleepReal: 5,
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle', state: 'blocked' }]) },
    },
  })

  const r = await claude.run({
    ...base,
    slowNoticeMs: 10,
    heartbeatMs: 10,
    blockedTimeoutMs: 30,
    onSlow: () => { avisosSlow += 1 },
    onNotice: () => { avisosNotice += 1 },
  })

  assert.equal(r.ok, false)
  assert.match(r.error, /blocked/)
  assert.equal(avisosSlow, 0, 'a "ainda trabalhando" nunca deveria repetir enquanto travada')
  assert.equal(avisosNotice, 1, 'o aviso de bloqueio ainda sai uma vez, como antes')
  // >= 1, não exatamente 1: o cleanup de fim de run() (limparSessao) também
  // chama stop+rm no mesmo bgId — o que importa aqui é que o cancelamento por
  // teto disparou pararSessao() por conta própria, não só o cleanup padrão.
  assert.ok(chamadas.filter((c) => c.args[0] === 'stop' && c.args[1] === 'abc12345').length >= 1, 'cancela a sessão travada sozinho')
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

// Uma falha isolada de `claude agents` (subprocesso, timeout, saída ruim) não
// pode ser lida como "a sessão sumiu" — a sessão pode estar genuinamente
// ocupada ainda. Ela ganha a mesma tolerância de 3 tentativas que uma sessão
// idle já tinha, em vez de derrubar o turno na primeira falha.
test('falha isolada em claude agents não derruba um turno que ainda está rodando', async () => {
  let chamadas = 0
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: () => {
        chamadas += 1
        // Duas falhas de listagem, depois volta a funcionar e mostra idle.
        if (chamadas <= 2) return { code: 1, stdout: '', stderr: 'agents indisponível' }
        return { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle' }]) }
      },
    },
    readReply: () => ({ content: 'sobrevivi às falhas', timestamp: new Date(2_000_000).toISOString() }),
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, true)
  assert.equal(r.text, 'sobrevivi às falhas')
  assert.ok(chamadas >= 3, `esperava pelo menos 3 chamadas a agents, veio ${chamadas}`)
})

test('falha persistente em claude agents eventualmente desiste, não trava para sempre', async () => {
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 1, stdout: '', stderr: 'agents sempre indisponível' },
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
  // Interromper solta o processo, mas a conversa continua na lista: apagar
  // entrada de `claude agents` não é coisa que o bot faça.
  assert.deepEqual(removidas, [])
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

test('o turno para o agente que criou, e não remove nada da lista', async () => {
  const paradas = []
  const removidas = []
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'idle' }]) },
      stop: (args) => { paradas.push(args[1]); return { code: 0 } },
      rm: (args) => { removidas.push(args[1]); return { code: 0 } },
    },
    readReply: () => ({ content: 'pronto', timestamp: new Date(2_000_000).toISOString() }),
  })
  const r = await claude.run({ ...base })
  assert.equal(r.ok, true)
  assert.deepEqual(paradas, ['abc12345'], 'solta o processo do próprio agente')
  assert.deepEqual(removidas, [], 'e não apaga nada de `claude agents`')
})

// Ele abre uma sessão no claude agents e manda o bot usá-la. Antes, o fim do
// turno varria a lista pelo sessionId retomado e a sessão dele sumia da
// listagem — que é exatamente o que ele não quer.
test('a sessão que ELE abriu continua na lista depois de o bot responder nela', async () => {
  const removidas = []
  const paradas = []
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: {
        code: 0,
        stdout: JSON.stringify([
          { id: 'dele', sessionId: 'sid-dele', status: 'idle' },
          { id: 'abc12345', sessionId: 'sid-bifurcada', status: 'idle' },
        ]),
      },
      stop: (args) => { paradas.push(args[1]); return { code: 0 } },
      rm: (args) => { removidas.push(args[1]); return { code: 0 } },
    },
    readReply: () => ({ content: 'pronto', timestamp: new Date(2_000_000).toISOString() }),
  })
  const r = await claude.run({ ...base, sessionId: 'sid-dele' })

  assert.equal(r.ok, true)
  assert.equal(r.sessionId, 'sid-bifurcada')
  assert.deepEqual(removidas, [], 'nada foi apagado')
  assert.ok(!paradas.includes('dele'), 'e a sessão dele nem foi parada')
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

test('onDispatch recebe o id do agente assim que dispara, e de novo quando o sessionId aparece', async () => {
  const avisos = []
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-novo', status: 'idle' }]) },
    },
    readReply: () => ({ content: 'pronto', timestamp: new Date(2_000_000).toISOString() }),
  })
  await claude.run({ ...base, onDispatch: (d) => avisos.push(d) })
  assert.deepEqual(avisos, [
    { bgId: 'abc12345', sessionId: null },
    { bgId: 'abc12345', sessionId: 'sid-novo' },
  ])
})

test('attach não dispara nada: acompanha o agente que já estava rodando e entrega a resposta', async () => {
  let checagens = 0
  const { claude, chamadas } = montar({
    respostas: {
      agents: () => {
        checagens += 1
        const status = checagens < 3 ? 'busy' : 'idle'
        return { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status }]) }
      },
    },
    readReply: () => ({ content: 'terminei depois do restart', timestamp: new Date(2_000_000).toISOString() }),
  })

  const r = await claude.attach({ cwd: '/tmp/algum', bgId: 'abc12345', sessionId: 'sid-1', sentAt: new Date(1_000_000).toISOString(), slowNoticeMs: 50 })
  assert.deepEqual(r, { ok: true, text: 'terminei depois do restart', sessionId: 'sid-1', error: null })
  assert.equal(chamadas.filter((c) => c.args[0] === '--bg').length, 0)
  assert.ok(checagens >= 3)
})

test('attach não aceita como nova uma resposta anterior ao pedido interrompido', async () => {
  const { claude } = montar({
    respostas: {
      agents: { code: 0, stdout: JSON.stringify([]) },
    },
    readReply: () => ({ content: 'resposta do turno anterior', timestamp: new Date(500_000).toISOString() }),
  })
  const r = await claude.attach({ cwd: '/tmp/algum', bgId: 'abc12345', sessionId: 'sid-1', sentAt: new Date(1_000_000).toISOString(), slowNoticeMs: 50 })
  assert.equal(r.ok, false)
})

test('attach também para o agente certo no /stop', async () => {
  const paradas = []
  const controle = new AbortController()
  const { claude } = montar({
    respostas: {
      agents: () => {
        controle.abort()
        return { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', status: 'busy' }]) }
      },
      stop: (args) => { paradas.push(args[1]); return { code: 0 } },
    },
  })
  const r = await claude.attach({ cwd: '/tmp/algum', bgId: 'abc12345', sessionId: 'sid-1', sentAt: new Date(1_000_000).toISOString(), slowNoticeMs: 50, signal: controle.signal })
  assert.equal(r.error, 'Interrompido.')
  assert.ok(paradas.includes('abc12345'))
})

// Recorded in production for a turn carrying an image: the agent spends its
// first ~13s starting up reported as no-status/idle with `state: working`,
// and only then flips to busy. Taking those looks as "quiet" ended the poll
// before the turn had begun, and the reply was never read.
test('agente ainda subindo (state working sem busy) não é tratado como terminado', async () => {
  const linhaDoTempo = [
    { status: undefined, state: 'working' },
    { status: 'idle', state: 'working' },
    { status: 'idle', state: 'working' },
    { status: 'idle', state: 'working' },
    { status: 'idle', state: 'working' },
    { status: 'busy', state: 'working' },
    { status: 'busy', state: 'working' },
    { status: 'idle', state: 'done' },
  ]
  let olhada = 0
  let respondeu = false
  const { claude } = montar({
    respostas: {
      '--bg': { code: 0, stdout: BG_OUT('abc12345') },
      agents: () => {
        const agora = linhaDoTempo[Math.min(olhada, linhaDoTempo.length - 1)]
        olhada += 1
        if (agora.state === 'done') respondeu = true
        return { code: 0, stdout: JSON.stringify([{ id: 'abc12345', sessionId: 'sid-1', ...agora }]) }
      },
    },
    readReply: () => (respondeu ? { content: 'um homem com uma cobra', timestamp: new Date(2_000_000).toISOString() } : null),
  })

  const r = await claude.run({ ...base })
  assert.deepEqual(r, { ok: true, text: 'um homem com uma cobra', sessionId: 'sid-1', error: null })
})
