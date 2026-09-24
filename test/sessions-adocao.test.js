import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessions } from '../src/sessions.js'
import { createStore } from '../src/store.js'

// Which conversation belongs to him has to survive a restart. It did not:
// the loader rebuilt each session without `adotadaDe`, so after every deploy
// the bot went back to forking his session instead of answering inside it.
function comArquivo() {
  const dir = mkdtempSync(join(tmpdir(), 'sessoes-adocao-'))
  const caminho = join(dir, 'state.json')
  return { caminho, abrir: () => createSessions({ store: createStore(caminho), defaultCwd: dir }) }
}

test('a adoção sobrevive ao restart', async () => {
  const { abrir } = comArquivo()
  const antes = abrir()
  antes.adotar('infra', { cwd: tmpdir(), claudeSessionId: 'DELE-1', agenteId: 'ag-1' })

  const depois = abrir()
  const s = depois.get('infra')
  assert.equal(s.adotadaDe, 'DELE-1', 'continua sendo a conversa dele depois do boot')
  assert.equal(s.agenteId, 'ag-1')
})

test('adotar um nome que o bot ainda não tinha também marca como dele', async () => {
  const { abrir } = comArquivo()
  const sessions = abrir()
  const nova = sessions.adotar('infra', { cwd: tmpdir(), claudeSessionId: 'DELE-2', agenteId: 'ag-2' })

  assert.equal(nova.adotadaDe, 'DELE-2')
  assert.equal(abrir().get('infra').adotadaDe, 'DELE-2', 'e isso também sobrevive ao restart')
})

test('sessão criada pelo bot não vira dele por acidente', async () => {
  const { abrir } = comArquivo()
  const sessions = abrir()
  sessions.create({ cwd: tmpdir(), name: 's1' })

  assert.equal(abrir().get('s1').adotadaDe, null)
})
