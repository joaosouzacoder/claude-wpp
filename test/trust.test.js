import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ensureTrusted } from '../src/trust.js'

function ambiente(config) {
  const home = mkdtempSync(join(tmpdir(), 'trust-'))
  writeFileSync(join(home, '.claude.json'), JSON.stringify(config))
  return home
}

function ler(home) {
  return JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))
}

test('cria a entrada do projeto quando o Claude nunca abriu essa pasta', () => {
  const home = ambiente({ projects: {} })
  ensureTrusted('/algum/dir', { home })
  assert.equal(ler(home).projects['/algum/dir'].hasTrustDialogAccepted, true)
})

test('cria o próprio projects quando o arquivo nem isso tinha', () => {
  const home = ambiente({ numStartups: 3 })
  ensureTrusted('/algum/dir', { home })
  const config = ler(home)
  assert.equal(config.numStartups, 3)
  assert.equal(config.projects['/algum/dir'].hasTrustDialogAccepted, true)
})

test('marca o projeto existente sem apagar os outros campos dele', () => {
  const home = ambiente({ projects: { '/algum/dir': { allowedTools: ['Bash'], hasTrustDialogAccepted: false } } })
  ensureTrusted('/algum/dir', { home })
  const projeto = ler(home).projects['/algum/dir']
  assert.equal(projeto.hasTrustDialogAccepted, true)
  assert.deepEqual(projeto.allowedTools, ['Bash'])
})

test('já confiado não reescreve o arquivo', () => {
  const home = ambiente({ projects: { '/algum/dir': { hasTrustDialogAccepted: true } } })
  const antes = readFileSync(join(home, '.claude.json'), 'utf8')
  ensureTrusted('/algum/dir', { home })
  assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), antes)
})

test('não mexe em outros projetos', () => {
  const home = ambiente({ projects: { '/outro/dir': { hasTrustDialogAccepted: true } } })
  ensureTrusted('/algum/dir', { home })
  const config = ler(home)
  assert.equal(config.projects['/algum/dir'].hasTrustDialogAccepted, true)
  assert.equal(config.projects['/outro/dir'].hasTrustDialogAccepted, true)
})

test('arquivo de config ausente não lança, só desiste', () => {
  const home = mkdtempSync(join(tmpdir(), 'trust-'))
  assert.doesNotThrow(() => ensureTrusted('/algum/dir', { home }))
})
