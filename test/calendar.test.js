import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createCalendar, quandoEm, janelaDoDia, horariosLivres, resumirEvento, horaLocal, instanteLocal,
} from '../src/calendar.js'

const SP = 'America/Sao_Paulo'
// 23/09/2026, 10:00 em São Paulo.
const AGORA = Math.floor(Date.UTC(2026, 8, 23, 13, 0) / 1000)
const emSP = (epoch) => new Intl.DateTimeFormat('pt-BR', { timeZone: SP, dateStyle: 'short', timeStyle: 'short' }).format(new Date(epoch * 1000))

test('quandoEm entende hoje, amanhã e data, com e sem hora', () => {
  assert.equal(emSP(quandoEm('hoje 14:00', SP, AGORA).inicio), '23/09/2026, 14:00')
  assert.equal(emSP(quandoEm('amanhã 09:30', SP, AGORA).inicio), '24/09/2026, 09:30')
  assert.equal(emSP(quandoEm('2026-10-01 08:00', SP, AGORA).inicio), '01/10/2026, 08:00')
  assert.equal(quandoEm('amanhã', SP, AGORA).diaInteiro, true)
})

test('quandoEm recusa o que não entende, em vez de chutar um horário', () => {
  for (const ruim of ['', null, 'semana que vem', '2026-13-01 10:00', 'hoje 25:00', 'hoje 9h']) {
    assert.throws(() => quandoEm(ruim, SP, AGORA), /não entendi|faltou a data/)
  }
})

test('a hora é a do fuso dele mesmo quando o servidor está em UTC', () => {
  // 14:00 em São Paulo é 17:00Z; o servidor desta máquina roda em UTC.
  const inicio = quandoEm('hoje 14:00', SP, AGORA).inicio
  assert.equal(new Date(inicio * 1000).toISOString(), '2026-09-23T17:00:00.000Z')
  assert.equal(horaLocal(inicio, SP), '14:00')
})

test('a virada do horário de verão não desloca o compromisso', () => {
  const NY = 'America/New_York'
  // 01/11/2026 é o dia em que Nova York volta uma hora.
  const antes = instanteLocal({ ano: 2026, mes: 10, dia: 31, hora: 9 }, NY)
  const depois = instanteLocal({ ano: 2026, mes: 11, dia: 1, hora: 9 }, NY)
  assert.equal(horaLocal(antes, NY), '09:00')
  assert.equal(horaLocal(depois, NY), '09:00')
  assert.equal(depois - antes, 25 * 3600, 'o dia da virada tem 25 horas')
})

test('janelaDoDia cobre o dia inteiro no fuso dele', () => {
  const { de, ate } = janelaDoDia('amanhã', SP, AGORA)
  assert.equal(emSP(de), '24/09/2026, 00:00')
  assert.equal(emSP(ate), '25/09/2026, 00:00')
})

const bloco = (hIni, hFim) => ({
  inicio: instanteLocal({ ano: 2026, mes: 9, dia: 24, hora: hIni }, SP),
  fim: instanteLocal({ ano: 2026, mes: 9, dia: 24, hora: hFim }, SP),
})

test('horariosLivres dá os buracos reais, juntando reunião sobreposta e colada', () => {
  const de = instanteLocal({ ano: 2026, mes: 9, dia: 24, hora: 9 }, SP)
  const ate = instanteLocal({ ano: 2026, mes: 9, dia: 24, hora: 18 }, SP)
  const eventos = [bloco(9, 10), bloco(10, 11), bloco(13, 14), bloco(13, 15)]

  const livres = horariosLivres({ de, ate, eventos }).map((l) => `${horaLocal(l.de, SP)}-${horaLocal(l.ate, SP)}`)
  assert.deepEqual(livres, ['11:00-13:00', '15:00-18:00'])
})

test('horariosLivres ignora frestas menores que o mínimo e o dia sem nada é inteiro livre', () => {
  const de = instanteLocal({ ano: 2026, mes: 9, dia: 24, hora: 9 }, SP)
  const ate = instanteLocal({ ano: 2026, mes: 9, dia: 24, hora: 12 }, SP)
  const colados = [bloco(9, 10), { inicio: de + 10 * 3600 + 15 * 60, fim: de + 12 * 3600 - 9 * 3600 + 9 * 3600 }]
  void colados

  const comFresta = horariosLivres({ de, ate, eventos: [bloco(9, 10), bloco(10, 12)] })
  assert.deepEqual(comFresta, [])

  const vazio = horariosLivres({ de, ate, eventos: [] })
  assert.equal(vazio.length, 1)
  assert.equal(horaLocal(vazio[0].de, SP), '09:00')
})

test('resumirEvento reduz o evento ao que ele precisa ouvir', () => {
  const ev = {
    id: 'abc', summary: '1:1 Milton', location: 'Meet',
    start: { dateTime: '2026-09-24T14:00:00-03:00' },
    end: { dateTime: '2026-09-24T14:30:00-03:00' },
    attendees: [{ email: 'joao.souza@sortenabet.bet.br', self: true, responseStatus: 'needsAction' }, { email: 'milton@x.com' }],
  }
  assert.deepEqual(resumirEvento(ev, SP), {
    id: 'abc', quando: '14:00-14:30', dia: '24/09', titulo: '1:1 Milton', onde: 'Meet',
    convidados: ['milton@x.com'], inicio: 1790269200, fim: 1790271000, minhaResposta: 'needsAction',
  })
})

function calendarioFalso({ respostas = [], erro = null } = {}) {
  const chamadas = []
  let i = 0
  const cal = createCalendar({
    token: async () => 'tok-secreto',
    timezone: SP,
    fetchImpl: async (url, init) => {
      chamadas.push({ url: String(url), metodo: init.method, corpo: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization })
      if (erro) return { ok: false, status: erro.status, json: async () => ({ error: { message: erro.message } }) }
      const r = respostas[i++] ?? {}
      return { ok: true, status: 200, json: async () => r }
    },
  })
  return { cal, chamadas }
}

test('listar pede a janela certa e devolve eventos resumidos', async () => {
  const { cal, chamadas } = calendarioFalso({
    respostas: [{ items: [{ id: '1', summary: 'Daily', start: { dateTime: '2026-09-24T09:00:00-03:00' }, end: { dateTime: '2026-09-24T09:15:00-03:00' } }] }],
  })
  const { de, ate } = janelaDoDia('amanhã', SP, AGORA)
  const eventos = await cal.listar({ de, ate })

  assert.equal(eventos[0].titulo, 'Daily')
  assert.equal(eventos[0].quando, '09:00-09:15')
  assert.match(chamadas[0].url, /calendars\/primary\/events/)
  assert.match(chamadas[0].url, /singleEvents=true/)
  assert.equal(chamadas[0].auth, 'Bearer tok-secreto')
})

test('criar monta início e fim a partir da duração e avisa convidados só quando há convidados', async () => {
  const { cal, chamadas } = calendarioFalso({ respostas: [{ id: 'novo', summary: 'Foco', start: { dateTime: '2026-09-24T09:00:00-03:00' }, end: { dateTime: '2026-09-24T11:00:00-03:00' } }] })
  const inicio = quandoEm('amanhã 09:00', SP, AGORA).inicio
  await cal.criar({ titulo: 'Foco', inicio, duracaoMin: 120 })

  assert.equal(chamadas[0].metodo, 'POST')
  assert.equal(chamadas[0].corpo.start.dateTime, '2026-09-24T12:00:00.000Z')
  assert.equal(chamadas[0].corpo.end.dateTime, '2026-09-24T14:00:00.000Z')
  assert.match(chamadas[0].url, /sendUpdates=none/)

  const comGente = calendarioFalso({ respostas: [{ id: 'x', start: {}, end: {} }] })
  await comGente.cal.criar({ titulo: 'Call', inicio, convidados: ['milton@x.com'] })
  assert.match(comGente.chamadas[0].url, /sendUpdates=all/)
  assert.deepEqual(comGente.chamadas[0].corpo.attendees, [{ email: 'milton@x.com' }])
})

test('mover preserva a duração do evento e devolve antes e depois', async () => {
  const antes = { id: 'e1', summary: '1:1', start: { dateTime: '2026-09-23T14:00:00-03:00' }, end: { dateTime: '2026-09-23T15:00:00-03:00' } }
  const depois = { ...antes, start: { dateTime: '2026-09-24T15:00:00-03:00' }, end: { dateTime: '2026-09-24T16:00:00-03:00' } }
  const { cal, chamadas } = calendarioFalso({ respostas: [antes, depois] })

  const r = await cal.mover({ id: 'e1', inicio: quandoEm('amanhã 15:00', SP, AGORA).inicio })
  assert.equal(r.antes.quando, '14:00-15:00')
  assert.equal(r.depois.quando, '15:00-16:00')
  assert.equal(chamadas[1].metodo, 'PATCH')
  // Uma hora de duração, preservada sem ninguém precisar dizer.
  assert.equal(chamadas[1].corpo.end.dateTime, '2026-09-24T19:00:00.000Z')
})

test('apagar devolve o que apagou, porque na agenda não existe desfazer', async () => {
  const ev = { id: 'e1', summary: 'Reunião', start: { dateTime: '2026-09-24T10:00:00-03:00' }, end: { dateTime: '2026-09-24T11:00:00-03:00' }, attendees: [{ email: 'a@b.com' }] }
  const { cal, chamadas } = calendarioFalso({ respostas: [ev, {}] })

  const apagado = await cal.apagar({ id: 'e1' })
  assert.equal(apagado.titulo, 'Reunião')
  assert.deepEqual(apagado.convidados, ['a@b.com'])
  assert.equal(chamadas[1].metodo, 'DELETE')
  assert.match(chamadas[1].url, /sendUpdates=all/)
})

test('responder marca a resposta dele e recusa evento em que ele não foi convidado', async () => {
  const ev = { id: 'e1', summary: 'Comitê', start: {}, end: {}, attendees: [{ email: 'chefe@x.com' }, { email: 'joao@x.com', self: true, responseStatus: 'needsAction' }] }
  const { cal, chamadas } = calendarioFalso({ respostas: [ev, { ...ev, attendees: [{ email: 'chefe@x.com' }, { email: 'joao@x.com', self: true, responseStatus: 'accepted' }] }] })

  const r = await cal.responder({ id: 'e1', resposta: 'sim' })
  assert.equal(r.minhaResposta, 'accepted')
  assert.equal(chamadas[1].corpo.attendees.find((a) => a.self).responseStatus, 'accepted')

  const semEle = calendarioFalso({ respostas: [{ id: 'e2', start: {}, end: {}, attendees: [{ email: 'outro@x.com' }] }] })
  await assert.rejects(semEle.cal.responder({ id: 'e2', resposta: 'sim' }), /não está na lista/)
  await assert.rejects(cal.responder({ id: 'e1', resposta: 'quem sabe' }), /sim, não ou talvez/)
})

test('erro de acesso vira uma frase clara, e o token nunca aparece', async () => {
  const { cal } = calendarioFalso({ erro: { status: 403, message: 'Request had insufficient authentication scopes.' } })
  await assert.rejects(
    cal.listar({ de: AGORA, ate: AGORA + 3600 }),
    (e) => /sem acesso à agenda/.test(e.message) && !/tok-secreto/.test(e.message),
  )
})
