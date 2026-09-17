import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'
import { createScheduler } from '../src/scheduler.js'

const flush = () => new Promise((r) => setImmediate(r))

// The scheduler talks to the world through send/decide/notify. Those are the
// I/O boundary, so the tests hand it plain recorders and assert on the rows and
// on what the user was told — never on "was the function called".
function montar({ decide, send } = {}) {
  let relogio = 1000
  const db = openDb(':memory:')
  const outbox = createOutbox({ db, now: () => relogio })
  const enviadas = []
  const avisos = []

  const scheduler = createScheduler({
    outbox,
    now: () => relogio,
    toleranceSec: 3600,
    log: { error() {} },
    notify: async (t) => { avisos.push(t) },
    send: send ?? (async (job) => { enviadas.push(job.body); return { ok: true, waId: `WA-${job.id}` } }),
    decide: decide ?? (async () => ({ send: true, reason: 'nada mudou' })),
  })

  return {
    outbox, scheduler, enviadas, avisos,
    avancar: (t) => { relogio = t },
    agendar: (extra = {}) => outbox.create({ chatJid: '5@s.whatsapp.net', chatName: 'Jane', body: 'traz o macbook', ...extra }),
  }
}

test('não envia o que você não aprovou', async () => {
  const c = montar()
  c.agendar({ scheduledFor: 1000 })
  await c.scheduler.tick()
  assert.deepEqual(c.enviadas, [])
})

test('envia o aprovado sem horário na primeira passada', async () => {
  const c = montar()
  const d = c.agendar()
  c.outbox.approve(d.id)
  await c.scheduler.tick()
  assert.deepEqual(c.enviadas, ['traz o macbook'])
  assert.equal(c.outbox.get(d.id).status, 'sent')
  assert.equal(c.outbox.get(d.id).sent_wa_id, `WA-${d.id}`)
})

test('segura o agendado até a hora marcada', async () => {
  const c = montar()
  const d = c.agendar({ scheduledFor: 2000 })
  c.outbox.approve(d.id)

  await c.scheduler.tick()
  assert.deepEqual(c.enviadas, [])

  c.avancar(2000)
  await c.scheduler.tick()
  assert.deepEqual(c.enviadas, ['traz o macbook'])
})

test('não manda duas vezes se a passada rodar de novo', async () => {
  const c = montar()
  const d = c.agendar()
  c.outbox.approve(d.id)
  await c.scheduler.tick()
  await c.scheduler.tick()
  assert.deepEqual(c.enviadas, ['traz o macbook'])
})

test('atraso além da tolerância vira pergunta, não vira mensagem fora de hora', async () => {
  const c = montar()
  const d = c.agendar({ scheduledFor: 2000 })
  c.outbox.approve(d.id)

  c.avancar(2000 + 3601)
  await c.scheduler.tick()

  assert.deepEqual(c.enviadas, [])
  assert.equal(c.outbox.get(d.id).status, 'pending')
  assert.match(c.avisos.join('\n'), /atras/i)
})

test('atraso dentro da tolerância ainda envia', async () => {
  const c = montar()
  const d = c.agendar({ scheduledFor: 2000 })
  c.outbox.approve(d.id)
  c.avancar(2000 + 3599)
  await c.scheduler.tick()
  assert.deepEqual(c.enviadas, ['traz o macbook'])
})

test('condicional que passa na verificação envia o texto que você aprovou', async () => {
  const c = montar({ decide: async () => ({ send: true, reason: 'ele não respondeu nada' }) })
  const d = c.agendar({ kind: 'conditional', checkPrompt: 'ele já disse se traz?' })
  c.outbox.approve(d.id)
  await c.scheduler.tick()
  assert.deepEqual(c.enviadas, ['traz o macbook'])
})

test('condicional reprovada não envia e conta o porquê', async () => {
  const c = montar({ decide: async () => ({ send: false, reason: 'ele confirmou ontem que traz' }) })
  const d = c.agendar({ kind: 'conditional', checkPrompt: 'ele já disse se traz?' })
  c.outbox.approve(d.id)
  await c.scheduler.tick()

  assert.deepEqual(c.enviadas, [])
  assert.equal(c.outbox.get(d.id).status, 'skipped')
  assert.equal(c.outbox.get(d.id).reason, 'ele confirmou ontem que traz')
  assert.match(c.avisos.join('\n'), /confirmou ontem que traz/)
})

test('verificação quebrada não vira envio às cegas: volta para você decidir', async () => {
  const c = montar({ decide: async () => { throw new Error('claude fora do ar') } })
  const d = c.agendar({ kind: 'conditional', checkPrompt: 'ele já disse se traz?' })
  c.outbox.approve(d.id)
  await c.scheduler.tick()

  assert.deepEqual(c.enviadas, [])
  assert.equal(c.outbox.get(d.id).status, 'pending')
  assert.match(c.avisos.join('\n'), /claude fora do ar/)
})

test('mensagem simples não passa por verificação nenhuma', async () => {
  const c = montar({ decide: async () => { throw new Error('não era pra ter sido chamado') } })
  const d = c.agendar()
  c.outbox.approve(d.id)
  await c.scheduler.tick()
  assert.deepEqual(c.enviadas, ['traz o macbook'])
})

test('falha no envio é registrada e avisada, sem repetir para sempre', async () => {
  const c = montar({ send: async () => ({ ok: false, error: 'whatsapp caiu' }) })
  const d = c.agendar()
  c.outbox.approve(d.id)
  await c.scheduler.tick()

  assert.equal(c.outbox.get(d.id).status, 'failed')
  assert.match(c.avisos.join('\n'), /whatsapp caiu/)
  await c.scheduler.tick()
  assert.equal(c.avisos.filter((a) => /whatsapp caiu/.test(a)).length, 1)
})

test('um job que explode não impede o próximo de sair', async () => {
  const c = montar({
    send: async (job) => {
      if (job.body === 'quebra') throw new Error('boom')
      return { ok: true, waId: 'WA-ok' }
    },
  })
  const ruim = c.agendar({ body: 'quebra' })
  const bom = c.agendar({ body: 'passa' })
  c.outbox.approve(ruim.id)
  c.outbox.approve(bom.id)

  await c.scheduler.tick()
  assert.equal(c.outbox.get(ruim.id).status, 'failed')
  assert.equal(c.outbox.get(bom.id).status, 'sent')
})

test('duas passadas simultâneas não mandam a mesma coisa duas vezes', async () => {
  let liberar
  const espera = new Promise((r) => { liberar = r })
  const enviadas = []
  const c = montar({
    send: async (job) => { await espera; enviadas.push(job.body); return { ok: true, waId: 'WA' } },
  })
  const d = c.agendar()
  c.outbox.approve(d.id)

  const a = c.scheduler.tick()
  const b = c.scheduler.tick()
  liberar()
  await Promise.all([a, b])

  assert.deepEqual(enviadas, ['traz o macbook'])
})

// start()/stop() são o único ponto de entrada que a produção de fato usa
// (index.js chama scheduler.start()/.stop()) — os testes acima só exercitam
// tick() diretamente, sem nunca provar que o próprio timer se comporta bem.
function montarComTimer({ due, log = { error() {} } } = {}) {
  return createScheduler({
    outbox: { due: due ?? (() => []) },
    send: async () => ({ ok: true, waId: 'WA' }),
    decide: async () => ({ send: true, reason: 'nada mudou' }),
    notify: async () => {},
    log,
    intervalMs: 1000,
  })
}

test('start() chamado duas vezes não duplica o timer', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    let chamadas = 0
    const scheduler = montarComTimer({ due: () => { chamadas += 1; return [] } })
    scheduler.start()
    scheduler.start()
    mock.timers.tick(1000)
    await flush()
    assert.equal(chamadas, 1, 'a segunda chamada a start() não deveria armar um segundo timer')
  } finally {
    mock.timers.reset()
  }
})

test('stop() realmente para o timer, sem mais disparos depois', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    let chamadas = 0
    const scheduler = montarComTimer({ due: () => { chamadas += 1; return [] } })
    scheduler.start()
    mock.timers.tick(1000)
    await flush()
    assert.equal(chamadas, 1)

    scheduler.stop()
    mock.timers.tick(5000)
    await flush()
    assert.equal(chamadas, 1, 'nenhum disparo novo depois do stop()')
  } finally {
    mock.timers.reset()
  }
})

test('um tick() que rejeita não trava o processo nem impede os próximos disparos', async () => {
  mock.timers.enable({ apis: ['setInterval'] })
  try {
    let chamadas = 0
    const erros = []
    const scheduler = montarComTimer({
      due: () => {
        chamadas += 1
        if (chamadas === 1) throw new Error('boom')
        return []
      },
      log: { error: (m) => erros.push(m) },
    })
    scheduler.start()

    mock.timers.tick(1000) // primeiro disparo: due() lança
    await flush()
    mock.timers.tick(1000) // segundo disparo: tem que acontecer normalmente
    await flush()

    assert.equal(chamadas, 2, 'o timer continua batendo mesmo depois de um tick() quebrado')
    assert.match(erros.join('\n'), /boom/)
  } finally {
    mock.timers.reset()
  }
})

test('um /no que chega enquanto a verificação condicional ainda está rodando vence o envio', async () => {
  // A janela de corrida de verdade não é dentro de despachar() (markSending é
  // síncrono, sem await entre ler due() e escrever "sending") — é durante o
  // await real de decide(), que pode levar segundos. O job continua
  // "approved" o tempo todo dessa espera, então um /no chega a tempo.
  let liberar
  const espera = new Promise((r) => { liberar = r })
  const c = montar({
    decide: async () => { await espera; return { send: true, reason: 'nada mudou' } },
  })
  const d = c.agendar({ kind: 'conditional', checkPrompt: 'já confirmou?' })
  c.outbox.approve(d.id)

  const rodando = c.scheduler.tick()
  c.outbox.cancel(d.id)
  liberar()
  await rodando

  assert.equal(c.outbox.get(d.id).status, 'canceled', 'a decisão do humano vence a escrita atrasada do scheduler')
  assert.deepEqual(c.enviadas, [], 'nunca chega a mandar de verdade')
})

test('send() que lança em vez de devolver {ok:false} ainda marca failed, não fica pendurado em sending', async () => {
  const c = montar({ send: async () => { throw new Error('boom') } })
  const d = c.agendar()
  c.outbox.approve(d.id)
  await c.scheduler.tick()
  assert.equal(c.outbox.get(d.id).status, 'failed')
})

test('reconciliação no boot pega job que ficou em sending (reinício no meio do envio) e devolve pra pendente', async () => {
  const c = montar()
  const d = c.agendar()
  c.outbox.approve(d.id)
  c.outbox.markSending(d.id)

  c.scheduler.start()
  c.scheduler.stop()
  await new Promise((r) => setImmediate(r))

  assert.equal(c.outbox.get(d.id).status, 'pending')
  assert.match(c.avisos.join('\n'), /reiniciei|não sei se chegou/i)
})
