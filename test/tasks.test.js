import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createTasks, proximaDiaria } from '../src/tasks.js'

const SP = 'America/Sao_Paulo'
const emSP = (epoch) => new Intl.DateTimeFormat('pt-BR', { timeZone: SP, dateStyle: 'short', timeStyle: 'short' }).format(new Date(epoch * 1000))

test('proximaDiaria cai na hora certa do fuso dele, hoje ou amanhã', () => {
  // 22/09/2026 08:00 em São Paulo (UTC-3).
  const manha = Math.floor(Date.UTC(2026, 8, 22, 11, 0) / 1000)
  assert.equal(emSP(proximaDiaria('09:00', SP, manha)), '22/09/2026, 09:00')

  // Passou das 9: é amanhã.
  const tarde = Math.floor(Date.UTC(2026, 8, 22, 21, 0) / 1000)
  assert.equal(emSP(proximaDiaria('09:00', SP, tarde)), '23/09/2026, 09:00')

  // Exatamente na hora conta como já passada, senão dispararia duas vezes.
  const emPonto = Math.floor(Date.UTC(2026, 8, 22, 12, 0) / 1000)
  assert.equal(emSP(proximaDiaria('09:00', SP, emPonto)), '23/09/2026, 09:00')
})

test('proximaDiaria atravessa a virada de mês e de ano', () => {
  const reveillon = Math.floor(Date.UTC(2026, 11, 31, 23, 30) / 1000) // 31/12 20:30 em SP
  assert.equal(emSP(proximaDiaria('09:00', SP, reveillon)), '01/01/2027, 09:00')
})

test('proximaDiaria respeita um fuso com horário de verão', () => {
  // Nova York, véspera do fim do horário de verão (01/11/2026).
  const NY = 'America/New_York'
  const antes = Math.floor(Date.UTC(2026, 9, 31, 20, 0) / 1000)
  const alvo = proximaDiaria('09:00', NY, antes)
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: NY, dateStyle: 'short', timeStyle: 'short' }).format(new Date(alvo * 1000))
  assert.equal(hora, '01/11/2026, 09:00')
})

test('proximaDiaria recusa horário que não é HH:MM', () => {
  for (const ruim of ['9', '25:00', '09:60', 'manhã', '', null]) {
    assert.throws(() => proximaDiaria(ruim, SP, 1000), /horário inválido/)
  }
})

function montar(agora = Math.floor(Date.UTC(2026, 8, 22, 11, 0) / 1000)) {
  let relogio = agora
  const tasks = createTasks({ db: openDb(':memory:'), timezone: SP, now: () => relogio })
  return { tasks, andar: (segundos) => { relogio += segundos }, agora: () => relogio }
}

test('uma tarefa diária reaparece no dia seguinte, no mesmo horário', () => {
  const { tasks, andar } = montar()
  const t = tasks.create({ prompt: 'confere o chamado da AWS e me conta', dailyAt: '09:00', label: 'cota aws' })
  assert.equal(emSP(t.next_run), '22/09/2026, 09:00')
  assert.deepEqual(tasks.due(t.next_run - 1), [])

  andar(2 * 3600)
  assert.deepEqual(tasks.due().map((x) => x.id), [t.id])

  tasks.ranOnce(t.id)
  assert.equal(emSP(tasks.get(t.id).next_run), '23/09/2026, 09:00')
  assert.equal(tasks.get(t.id).status, 'ativa')
  assert.deepEqual(tasks.due(), [], 'e não dispara de novo no mesmo dia')
})

test('uma tarefa de uma vez só some depois de rodar', () => {
  const { tasks, andar, agora } = montar()
  const t = tasks.create({ prompt: 'me lembra de ligar pro contador', at: agora() + 3600 })
  andar(3601)
  assert.deepEqual(tasks.due().map((x) => x.id), [t.id])

  tasks.ranOnce(t.id)
  assert.equal(tasks.get(t.id).status, 'feita')
  assert.deepEqual(tasks.list(), [])
})

test('encerrar e cancelar tiram a tarefa da lista, e só funcionam uma vez', () => {
  const { tasks } = montar()
  const a = tasks.create({ prompt: 'x', dailyAt: '09:00' })
  const b = tasks.create({ prompt: 'y', dailyAt: '10:00' })
  assert.deepEqual(tasks.list().map((t) => t.id), [a.id, b.id])

  assert.equal(tasks.finish(a.id).status, 'feita')
  assert.equal(tasks.cancel(b.id).status, 'cancelada')
  assert.deepEqual(tasks.list(), [])
  assert.equal(tasks.finish(a.id), null)
  assert.equal(tasks.cancel(b.id), null)
})

test('create recusa tarefa sem pedido, sem horário, com dois horários ou no passado', () => {
  const { tasks, agora } = montar()
  assert.throws(() => tasks.create({ prompt: '  ', dailyAt: '09:00' }), /sem pedido/)
  assert.throws(() => tasks.create({ prompt: 'x' }), /sem horário/)
  assert.throws(() => tasks.create({ prompt: 'x', dailyAt: '09:00', at: agora() + 60 }), /dois horários/)
  assert.throws(() => tasks.create({ prompt: 'x', at: agora() - 60 }), /já passou/)
})
