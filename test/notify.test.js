import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createNotifier, formatAlert } from '../src/notify.js'

function montar({ falhar = () => false, dedupMs = 1000, maxKeys } = {}) {
  const enviados = []
  let agora = 0
  const notifier = createNotifier({
    send: async (texto) => {
      if (falhar()) throw new Error('whatsapp fora do ar')
      enviados.push(texto)
    },
    dedupMs,
    now: () => agora,
    ...(maxKeys ? { maxKeys } : {}),
  })
  return { notifier, enviados, avancar: (ms) => { agora += ms } }
}

test('formatAlert marca a origem quando existe', () => {
  assert.equal(formatAlert({ text: 'disco em 91%', source: 'srv1' }), '🔔 [srv1] disco em 91%')
  assert.equal(formatAlert({ text: 'disco em 91%' }), '🔔 disco em 91%')
})

test('sem key, todo alerta sai', async () => {
  const { notifier, enviados } = montar()
  await notifier.notify({ text: 'a' })
  await notifier.notify({ text: 'a' })
  assert.equal(enviados.length, 2)
})

test('mesma key dentro da janela sai uma vez só', async () => {
  const { notifier, enviados, avancar } = montar({ dedupMs: 1000 })
  assert.deepEqual(await notifier.notify({ text: 'CI quebrou', key: 'ci-main' }), { sent: true, deduped: false })
  avancar(999)
  assert.deepEqual(await notifier.notify({ text: 'CI quebrou', key: 'ci-main' }), { sent: false, deduped: true })
  assert.equal(enviados.length, 1)
})

test('mesma key depois da janela volta a sair', async () => {
  const { notifier, enviados, avancar } = montar({ dedupMs: 1000 })
  await notifier.notify({ text: 'CI quebrou', key: 'ci-main' })
  avancar(1000)
  await notifier.notify({ text: 'CI quebrou de novo', key: 'ci-main' })
  assert.equal(enviados.length, 2)
})

test('keys diferentes não se atrapalham', async () => {
  const { notifier, enviados } = montar()
  await notifier.notify({ text: 'a', key: 'x' })
  await notifier.notify({ text: 'b', key: 'y' })
  assert.equal(enviados.length, 2)
})

test('envio que falhou não conta: a próxima tentativa com a mesma key sai', async () => {
  let falha = true
  const { notifier, enviados } = montar({ falhar: () => falha })
  await assert.rejects(notifier.notify({ text: 'deploy terminou', key: 'deploy' }), /fora do ar/)
  falha = false
  assert.deepEqual(await notifier.notify({ text: 'deploy terminou', key: 'deploy' }), { sent: true, deduped: false })
  assert.equal(enviados.length, 1)
})

test('o mapa de keys tem teto: key nova por chamada não cresce sem limite', async () => {
  const { notifier, enviados } = montar({ dedupMs: 1_000_000, maxKeys: 3 })
  for (const k of ['a', 'b', 'c', 'd']) await notifier.notify({ text: k, key: k })
  // 'a' foi a mais antiga a sair do mapa quando 'd' entrou, então volta a passar.
  assert.deepEqual(await notifier.notify({ text: 'a', key: 'a' }), { sent: true, deduped: false })
  // 'd' ainda está na janela.
  assert.deepEqual(await notifier.notify({ text: 'd', key: 'd' }), { sent: false, deduped: true })
  assert.equal(enviados.length, 5)
})
