import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReviewer, lerPedidos, promptRevisao, lerRemote, termosDeBusca, pareceSegredo, semAssinatura, lerVeredito, lerMarca, marca, estadoCi, NEGADOS } from '../src/review.js'

const MILTON = '5511911111111'
const OUTRO = '5511922222222'
const PR = 'https://github.com/Solvers-it/my-solvers/pull/42'

const chave = (numero, extra = {}) => ({ remoteJid: `${numero}@s.whatsapp.net`, fromMe: false, ...extra })

function montar({ estado = 'OPEN', revisao = 'Sem achados.\n— Claudinei', falhaClaude = false, falhaGh = null, diffGrande = false, projectsDir = null, clones = {}, memoria = true, anteriores = [], maxPorPr = 3, delta = 'diff --git a/z b/z\n+mudou', views = null, worktreesDir = null, checklistsDir = null, falhaFetch = false } = {}) {
  const VERDE = [{ __typename: 'CheckRun', name: 'Backend', status: 'COMPLETED', conclusion: 'SUCCESS' }]
  const base = { title: 'feat: x', body: 'desc', author: { login: 'milton' }, state: estado, isDraft: false, mergeable: 'MERGEABLE', baseRefName: 'develop', headRefName: 'feat/x', baseRefOid: 'aaaaaaa1', headRefOid: 'bbbbbbb2', additions: 3, deletions: 1, changedFiles: 1, statusCheckRollup: VERDE, commits: [{ oid: 'bbbbbbb2', messageHeadline: 'feat: x', messageBody: '' }] }
  const fila = [...(views ?? [{}])]
  let vistas = 0
  const chamadas = []
  const enviados = []
  const avisos = []
  let liberar
  const portao = new Promise((r) => { liberar = r })
  const exec = async (bin, args, opts = {}) => {
    let diffNoDisco = null
    try { if (bin === 'claude' && opts.cwd) diffNoDisco = readFileSync(join(opts.cwd, '.claude-wpp-review', 'pr.diff'), 'utf8') } catch {}
    chamadas.push({ bin, args, input: opts.input ?? null, cwd: opts.cwd ?? null, diffNoDisco })
    if (bin === 'gh' && falhaGh === args[1]) return { code: 1, stdout: '', stderr: 'boom' }
    if (bin === 'gh' && diffGrande && args[1] === 'diff') return { code: 1, stdout: '', stderr: 'HTTP 406: the diff exceeded the maximum number of lines (20000)\nPullRequest.diff too_large' }
    if (bin === 'gh' && args[0] === 'api' && args[1] === 'user') return { code: 0, stdout: 'joaosouzacoder\n' }
    if (bin === 'gh' && args[0] === 'api' && /\/reviews$/.test(args[2] ?? '')) return { code: 0, stdout: anteriores.map((a) => JSON.stringify(a)).join('\n') }
    if (bin === 'gh' && args[0] === 'api' && /\/issues\/\d+\/comments$/.test(args[2] ?? '')) return { code: 0, stdout: '### milton\nObrigado, corrigi em bbbbbbb2.' }
    if (bin === 'gh' && args[0] === 'api' && /\/compare\//.test(args[1] ?? '')) return delta == null ? { code: 1, stdout: '', stderr: 'HTTP 404' } : { code: 0, stdout: delta }
    if (bin === 'gh' && args[0] === 'api') return { code: 0, stdout: 'diff --git a/y b/y\n+por arquivo' }
    if (bin === 'gh' && args[1] === 'view') {
      const extra = fila.length > 1 ? fila.shift() : fila[0]
      vistas++
      return { code: 0, stdout: JSON.stringify({ url: args[2], ...base, ...extra }) }
    }
    if (bin === 'gh' && args[1] === 'merge') return { code: 0, stdout: '' }
    if (bin === 'gh' && args[1] === 'diff') return { code: 0, stdout: 'diff --git a/x b/x\n+ok' }
    if (bin === 'gh' && args[1] === 'review') return { code: 0, stdout: '' }
    if (bin === 'git') {
      const clone = clones[args[1]]
      if (!clone) return { code: 128, stdout: '', stderr: 'not a repo' }
      if (args[2] === 'remote') return { code: 0, stdout: `${clone.remote}\n` }
      if (args[2] === 'rev-parse') return { code: 0, stdout: args[3] === '--abbrev-ref' ? `${clone.branch}\n` : `${clone.head ?? 'bbbbbbb2'}\n` }
      if (args.includes('fetch')) return falhaFetch ? { code: 128, stdout: '', stderr: 'denied' } : { code: 0, stdout: '' }
      if (args[2] === 'worktree' || args[2] === 'update-ref') return { code: 0, stdout: '' }
      if (args[2] === 'diff') return { code: 0, stdout: 'diff --git a/w b/w\n+do worktree' }
      if (args[2] === 'show') return args[3].endsWith(':CLAUDE.md') ? { code: 0, stdout: 'Regra da base.' } : { code: 128, stdout: '', stderr: 'no file' }
      if (args[2] === 'cat-file') return (clone.commits ?? []).includes(args[4]) ? { code: 0, stdout: 'commit\n' } : { code: 128, stdout: '', stderr: 'bad object' }
    }
    if (bin === 'ai-memory' && args[0] === 'search') {
      return memoria ? { code: 0, stdout: JSON.stringify([{ path: 'gotchas/rls.md', title: 'RLS por tenant', snippet: 's' }]) } : { code: 1, stdout: '', stderr: 'no project' }
    }
    if (bin === 'ai-memory' && args[0] === 'read-page') return { code: 0, stdout: 'Toda query nova precisa filtrar por tenant.' }
    if (bin === 'claude') {
      await portao
      return falhaClaude ? { code: 1, stdout: '', stderr: 'erro' } : { code: 0, stdout: revisao }
    }
    throw new Error(`inesperado: ${bin} ${args.join(' ')}`)
  }
  const revisor = createReviewer({
    requesters: [MILTON],
    owners: ['solvers-it'],
    exec,
    sendAsBot: async (jid, texto) => { enviados.push({ jid, texto }) },
    notifyOwner: async (texto) => { avisos.push(texto) },
    nomeDe: () => 'Milton Yoshida',
    projectsDir,
    maxPorPr,
    worktreesDir,
    checklistsDir,
    dormir: async () => {},
    agora: () => vistas * 30_000,
    ciWaitMs: 5 * 30_000,
    log: { info() {}, warn() {}, error() {} },
  })
  const esperar = async () => {
    liberar()
    for (let i = 0; i < 50 && !revisor.ocioso(); i++) await new Promise((r) => setImmediate(r))
  }
  return { revisor, chamadas, enviados, avisos, esperar, liberar }
}

test('lerPedidos acha cada link de PR uma vez só', () => {
  const pedidos = lerPedidos(`olha ${PR} e ${PR}/files e https://github.com/a/b/pull/7`)
  assert.deepEqual(pedidos.map((p) => p.chave), ['solvers-it/my-solvers#42', 'a/b#7'])
})

test('pedido do Milton: avisa, revisa sem ferramentas e comenta no PR', async () => {
  const { revisor, chamadas, enviados, avisos, esperar } = montar()
  assert.equal(await revisor.onOther({ key: chave(MILTON), text: `revisa pra mim? ${PR}` }), true)
  assert.match(enviados[0].texto, /Vou revisar/)
  await esperar()

  const claude = chamadas.find((c) => c.bin === 'claude')
  assert.deepEqual(claude.args.slice(claude.args.indexOf('--tools'), claude.args.indexOf('--tools') + 2), ['--tools', ''])
  assert.match(claude.input, /diff --git a\/x b\/x/)

  const review = chamadas.find((c) => c.args[1] === 'review')
  assert.deepEqual(review.args, ['pr', 'review', PR, '--comment', '--body-file', '-'])
  assert.equal(review.input.split('\n\n<!--')[0], 'Sem achados.')
  assert.match(review.input, /<!-- claude-wpp:veredito .* limpo=0 -->/)
  assert.match(claude.input, /Não assine/)
  assert.doesNotMatch(claude.input, /Termine com/)
  assert.ok(!chamadas.some((c) => c.args.includes('--approve') || c.args.includes('--request-changes')))

  assert.match(enviados.at(-1).texto, /Revisei o PR .* deixei os comentários/)
  assert.match(avisos[0], /Milton Yoshida pediu revisão/)
})

test('quem não está liberado não é tratado aqui', async () => {
  const { revisor, chamadas, enviados } = montar()
  assert.equal(await revisor.onOther({ key: chave(OUTRO), text: PR }), false)
  assert.deepEqual(chamadas, [])
  assert.deepEqual(enviados, [])
})

test('mensagem do Milton sem link de PR recebe como pedir, e nada roda', async () => {
  const { revisor, chamadas, enviados } = montar()
  assert.equal(await revisor.onOther({ key: chave(MILTON), text: 'avalia a PR #144 por favor' }), true)
  assert.deepEqual(chamadas, [])
  assert.match(enviados[0].texto, /link completo do PR/)
  assert.match(enviados[0].texto, /github\.com\/solvers-it\//)
})

test('link sem https também vale', () => {
  assert.equal(lerPedidos('github.com/Solvers-it/my-solvers/pull/9')[0].url, 'https://github.com/Solvers-it/my-solvers/pull/9')
})

test('grupo e transmissão não contam, mesmo vindo do Milton', async () => {
  const { revisor } = montar()
  assert.equal(await revisor.onOther({ key: { remoteJid: '123@g.us', participant: `${MILTON}@s.whatsapp.net` }, text: PR }), false)
  assert.equal(await revisor.onOther({ key: chave(MILTON, { broadcast: true }), text: PR }), false)
})

test('PR de fora da solvers-it é recusado sem chamar o gh', async () => {
  const { revisor, chamadas, enviados } = montar()
  assert.equal(await revisor.onOther({ key: chave(MILTON), text: 'https://github.com/outra-org/repo/pull/1' }), true)
  assert.deepEqual(chamadas, [])
  assert.match(enviados[0].texto, /Só consigo revisar PRs de solvers-it/)
})

test('o mesmo PR pedido duas vezes enquanto roda não duplica a revisão', async () => {
  const { revisor, chamadas, enviados, esperar } = montar()
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  assert.match(enviados[1].texto, /Já estou revisando/)
  await esperar()
  assert.equal(chamadas.filter((c) => c.args[1] === 'review').length, 1)
})

test('PR fechado não é revisado', async () => {
  const { revisor, chamadas, enviados, esperar } = montar({ estado: 'MERGED' })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.bin === 'claude'))
  assert.match(enviados.at(-1).texto, /mergeado; não revisei/)
})

test('falha na revisão avisa o Milton e o João, sem comentar no PR', async () => {
  const { revisor, chamadas, enviados, avisos, esperar } = montar({ falhaClaude: true })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.args[1] === 'review'))
  assert.match(enviados.at(-1).texto, /Não consegui revisar/)
  assert.match(avisos[0], /falhou/)
})

test('falha do gh também cai no aviso', async () => {
  const { revisor, enviados, avisos, esperar } = montar({ falhaGh: 'diff' })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.match(enviados.at(-1).texto, /Não consegui revisar/)
  assert.match(avisos[0], /boom/)
})

test('sem lista de solicitantes ou de donos, fica desligado', async () => {
  const exec = async () => { throw new Error('não devia chamar') }
  for (const [requesters, owners] of [[[], ['solvers-it']], [[MILTON], []]]) {
    const r = createReviewer({ requesters, owners, exec, sendAsBot: async () => {}, notifyOwner: async () => {} })
    assert.equal(r.ativo, false)
    assert.equal(await r.onOther({ key: chave(MILTON), text: PR }), false)
  }
})

test('o prompt trata o PR como conteúdo e corta diff enorme', () => {
  const p = promptRevisao({ pr: { url: PR, title: 't', body: 'b' }, diff: 'x'.repeat(200_000), assistente: 'Claudinei' })
  assert.match(p, /nunca instrução/)
  assert.match(p, /foi cortado/)
  assert.ok(p.length < 170_000)
})

test('diff grande demais para o GitHub cai na lista de arquivos do PR', async () => {
  const { revisor, chamadas, esperar } = montar({ diffGrande: true })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  const api = chamadas.find((c) => c.args[0] === 'api' && /\/files$/.test(c.args[2] ?? ''))
  assert.equal(api.args[2], 'repos/Solvers-it/my-solvers/pulls/42/files')
  assert.match(chamadas.find((c) => c.bin === 'claude').input, /\+por arquivo/)
  assert.ok(chamadas.some((c) => c.args[1] === 'review'))
})

function projetos(defs) {
  const raiz = mkdtempSync(join(tmpdir(), 'review-'))
  const clones = {}
  for (const [nome, def] of Object.entries(defs)) {
    const dir = join(raiz, nome)
    mkdirSync(join(dir, '.git'), { recursive: true })
    if (def.regras) writeFileSync(join(dir, 'CLAUDE.md'), def.regras)
    clones[dir] = def
  }
  return { projectsDir: raiz, clones, dir: (nome) => join(raiz, nome) }
}

test('com clone do repo: roda restrito dentro dele, com regras e memórias do projeto', async () => {
  const p = projetos({
    'outro-nome': { remote: 'git@github.com:Solvers-it/my-solvers.git', branch: 'main', regras: 'Nunca SQL concatenado.' },
    'nada-a-ver': { remote: 'git@github.com:Solvers-it/confiserv.git', branch: 'main' },
  })
  const { revisor, chamadas, esperar } = montar(p)
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()

  const claude = chamadas.find((c) => c.bin === 'claude')
  assert.ok(claude.args.includes('--restricted'))
  assert.ok(claude.args.includes('--strict-mcp-config'))
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], 'Read,Grep,Glob')
  assert.ok(!claude.args.includes('--dangerously-skip-permissions'))
  for (const negado of NEGADOS) assert.ok(claude.args.includes(negado))
  assert.match(claude.input, /Nunca SQL concatenado/)
  assert.match(claude.input, /Toda query nova precisa filtrar por tenant/)
  assert.match(claude.input, /NÃO é o branch do PR/)

  const busca = chamadas.find((c) => c.bin === 'ai-memory' && c.args[0] === 'search')
  assert.deepEqual(busca.args.slice(1, 5), ['--workspace', 'default', '--project', 'solvers-it-my-solvers'])
  assert.ok(!busca.args.includes('--global'))
})

test('entre dois clones do mesmo repo, ganha o que está no branch do PR', async () => {
  const p = projetos({
    'my-solvers': { remote: 'git@github.com:Solvers-it/my-solvers.git', branch: 'main' },
    'my-solvers-feat': { remote: 'https://github.com/Solvers-it/my-solvers', branch: 'feat/x' },
  })
  const { revisor, chamadas, esperar } = montar(p)
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.match(chamadas.find((c) => c.bin === 'claude').input, /no branch `feat\/x` — o mesmo branch do PR/)
})

test('sem clone, segue sem ferramentas e sem memórias', async () => {
  const p = projetos({ 'nada-a-ver': { remote: 'git@github.com:Solvers-it/confiserv.git', branch: 'main' } })
  const { revisor, chamadas, esperar } = montar(p)
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  const claude = chamadas.find((c) => c.bin === 'claude')
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '')
  assert.ok(!claude.args.includes('--restricted'))
  assert.ok(!chamadas.some((c) => c.bin === 'ai-memory'))
})

test('memória indisponível não impede a revisão', async () => {
  const p = projetos({ x: { remote: 'git@github.com:Solvers-it/my-solvers.git', branch: 'main' } })
  const { revisor, chamadas, esperar } = montar({ ...p, memoria: false })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(chamadas.some((c) => c.args[1] === 'review'))
  assert.doesNotMatch(chamadas.find((c) => c.bin === 'claude').input, /<memorias>/)
})

test('revisão com cara de credencial não é postada', async () => {
  const { revisor, chamadas, enviados, avisos, esperar } = montar({ revisao: 'achei: ghp_' + 'a'.repeat(36) })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.args[1] === 'review'))
  assert.match(enviados.at(-1).texto, /Não consegui revisar/)
  assert.match(avisos[0], /parece credencial/)
})

test('auxiliares: remote, termos de busca e detector de segredo', () => {
  assert.deepEqual(lerRemote('git@github.com:Solvers-it/my-solvers.git'), { owner: 'Solvers-it', repo: 'my-solvers' })
  assert.deepEqual(lerRemote('https://github.com/a/b'), { owner: 'a', repo: 'b' })
  assert.equal(lerRemote('git@gitlab.com:a/b.git'), null)
  assert.deepEqual(termosDeBusca('feat(api): "notificação" OR push*'), ['feat', 'notificacao', 'push'])
  assert.ok(pareceSegredo('AKIA' + 'ABCDEFGHIJKLMNOP'))
  assert.ok(pareceSegredo('-----BEGIN RSA PRIVATE KEY-----'))
  assert.ok(!pareceSegredo('usar `process.env.TOKEN` em vez de literal'))
})

test('assinatura do assistente no fim é removida, o resto fica', () => {
  assert.equal(semAssinatura('Achado 1.\n\n— Claudinei'), 'Achado 1.')
  assert.equal(semAssinatura('Achado 1.\n-- Claudinei, assistente do João'), 'Achado 1.')
  assert.equal(semAssinatura('- item que cita Claudinei no meio\nfim'), '- item que cita Claudinei no meio\nfim')
})

const COPIA = 'https://github.com/Solvers-it/my-solvers-solversone/pull/1'

test('repo copiado de outro: usa o clone que tem o commit base, com as memórias do original', async () => {
  const p = projetos({
    'nada-a-ver': { remote: 'git@github.com:Solvers-it/confiserv.git', branch: 'main', commits: [] },
    'my-solvers': { remote: 'git@github.com:Solvers-it/my-solvers.git', branch: 'main', commits: ['aaaaaaa1'], regras: 'Regra do original.' },
  })
  const { revisor, chamadas, esperar } = montar(p)
  await revisor.onOther({ key: chave(MILTON), text: COPIA })
  await esperar()
  const claude = chamadas.find((c) => c.bin === 'claude')
  assert.ok(claude.args.includes('--restricted'))
  assert.match(claude.input, /clone local de `Solvers-it\/my-solvers`, de onde este repositório foi copiado/)
  assert.match(claude.input, /Regra do original/)
  const busca = chamadas.find((c) => c.bin === 'ai-memory' && c.args[0] === 'search')
  assert.equal(busca.args[busca.args.indexOf('--project') + 1], 'solvers-it-my-solvers')
})

test('entre clones por histórico, ganha o que também tem o commit do head', async () => {
  const p = projetos({
    a: { remote: 'git@github.com:Solvers-it/my-solvers.git', branch: 'main', commits: ['aaaaaaa1'] },
    b: { remote: 'git@github.com:Solvers-it/my-solvers.git', branch: 'feat/y', commits: ['aaaaaaa1', 'bbbbbbb2'] },
  })
  const { revisor, chamadas, esperar } = montar(p)
  await revisor.onOther({ key: chave(MILTON), text: COPIA })
  await esperar()
  assert.match(chamadas.find((c) => c.bin === 'claude').input, /no branch `feat\/y`/)
})

test('clone sem o commit base não serve: segue sem ferramentas', async () => {
  const p = projetos({ x: { remote: 'git@github.com:Solvers-it/my-solvers.git', branch: 'main', commits: ['outro'] } })
  const { revisor, chamadas, esperar } = montar(p)
  await revisor.onOther({ key: chave(MILTON), text: COPIA })
  await esperar()
  const claude = chamadas.find((c) => c.bin === 'claude')
  assert.ok(!claude.args.includes('--restricted'))
  assert.ok(!chamadas.some((c) => c.bin === 'ai-memory'))
})

const ANTERIOR = (commit, quando, corpo = 'Bloqueante: falta teste em a.js:3') => ({ commit_id: commit, submitted_at: quando, body: corpo })

test('segunda revisão é incremental: anterior, respostas e o que mudou desde então', async () => {
  const { revisor, chamadas, enviados, avisos, esperar } = montar({ anteriores: [ANTERIOR('aaaaaaa0', '2026-11-11T15:00:00Z')] })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  const input = chamadas.find((c) => c.bin === 'claude').input
  assert.match(input, /revisão 2 de no máximo 3/)
  assert.match(input, /Bloqueante: falta teste em a\.js:3/)
  assert.match(input, /corrigi em bbbbbbb2/)
  assert.match(input, /\+mudou/)
  assert.match(input, /só \[BLOQUEADOR\] ou \[MAIOR\] introduzidos/)
  const compare = chamadas.find((c) => /compare/.test(c.args[1] ?? ''))
  assert.equal(compare.args[1], 'repos/Solvers-it/my-solvers/compare/aaaaaaa0...bbbbbbb2')
  assert.ok(chamadas.some((c) => c.args[1] === 'review'))
  assert.match(avisos[0], /\(2\/3\)/)
  assert.doesNotMatch(enviados.at(-1).texto, /última/)
})

test('a última revisão permitida avisa que foi a última', async () => {
  const { revisor, chamadas, enviados, esperar } = montar({ anteriores: [ANTERIOR('a1a1a1a', '2026-11-11T15:00:00Z'), ANTERIOR('a2a2a2a', '2026-11-11T15:10:00Z')] })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.match(chamadas.find((c) => c.bin === 'claude').input, /revisão 3 de no máximo 3 deste PR — a última/)
  assert.match(enviados.at(-1).texto, /Foi a última revisão deste PR/)
})

test('no teto, não revisa e avisa os dois', async () => {
  const tres = [ANTERIOR('a1a1a1a', '2026-11-11T15:00:00Z'), ANTERIOR('a2a2a2a', '2026-11-11T15:10:00Z'), ANTERIOR('a3a3a3a', '2026-11-11T15:20:00Z')]
  const { revisor, chamadas, enviados, avisos, esperar } = montar({ anteriores: tres })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.bin === 'claude'))
  assert.ok(!chamadas.some((c) => c.args[1] === 'review'))
  assert.match(enviados.at(-1).texto, /3 vezes, que é o limite/)
  assert.match(avisos[0], /teto é 3/)
})

test('o mesmo commit não é revisado de novo', async () => {
  const { revisor, chamadas, enviados, avisos, esperar } = montar({ anteriores: [ANTERIOR('bbbbbbb2', '2026-11-11T15:00:00Z')] })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.bin === 'claude'))
  assert.match(enviados.at(-1).texto, /neste commit \(bbbbbbb\)/)
  assert.deepEqual(avisos, [])
})

test('histórico reescrito: sem delta, a revisão segue incremental com o diff completo', async () => {
  const { revisor, chamadas, esperar } = montar({ anteriores: [ANTERIOR('aaaaaaa0', '2026-11-11T15:00:00Z')], delta: null })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  const input = chamadas.find((c) => c.bin === 'claude').input
  assert.match(input, /histórico reescrito/)
  assert.match(input, /diff --git a\/x b\/x/)
})

const LIMPA = 'Tudo certo, pode mergear.\n\n### Menores\n1. nome.\nVEREDITO: {"bloqueadores": 0, "maiores": 0}'
const SUJA = 'Falta tenancy.\n\n### [BLOQUEADOR]\n- a.go:3 sem uid_tenant.\nVEREDITO: {"bloqueadores": 1, "maiores": 0}'

test('revisão limpa com CI verde: comenta sem a linha do veredito e faz squash merge no commit revisado', async () => {
  const { revisor, chamadas, enviados, avisos, esperar } = montar({ revisao: LIMPA })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  const review = chamadas.find((c) => c.args[1] === 'review')
  assert.doesNotMatch(review.input, /VEREDITO/)
  assert.match(review.input, /limpo=1/)
  const merge = chamadas.find((c) => c.args[1] === 'merge')
  assert.deepEqual(merge.args, ['pr', 'merge', PR, '--squash', '--match-head-commit', 'bbbbbbb2'])
  assert.ok(!merge.args.includes('--admin'))
  assert.match(enviados.at(-1).texto, /Fiz o squash merge na develop/)
  assert.match(avisos.at(-1), /mergeei/)
})

test('com bloqueador não há merge', async () => {
  const { revisor, chamadas, enviados, esperar } = montar({ revisao: SUJA })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.args[1] === 'merge'))
  assert.match(enviados.at(-1).texto, /1 bloqueador/)
})

test('veredito zero mas texto com seção [MAIOR] não mergeia', async () => {
  const { revisor, chamadas, esperar } = montar({ revisao: 'x\n### [MAIOR]\n- b.go:1\nVEREDITO: {"bloqueadores": 0, "maiores": 0}' })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.args[1] === 'merge'))
})

test('sem linha de veredito não há merge', async () => {
  const { revisor, chamadas, esperar } = montar({ revisao: 'Tudo certo, pode mergear.' })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.args[1] === 'merge'))
})

for (const [caso, extra, motivo] of [
  ['CI vermelho', { statusCheckRollup: [{ __typename: 'CheckRun', name: 'Backend', status: 'COMPLETED', conclusion: 'FAILURE' }] }, /CI falhou \(Backend\)/],
  ['sem CI', { statusCheckRollup: [] }, /não tem CI/],
  ['base main', { baseRefName: 'main' }, /só mergeio na develop/],
  ['rascunho', { isDraft: true }, /rascunho/],
  ['conflito', { mergeable: 'CONFLICTING' }, /conflito/],
]) {
  test(`revisão limpa mas ${caso}: não mergeia e diz por quê`, async () => {
    const { revisor, chamadas, enviados, esperar } = montar({ revisao: LIMPA, views: [extra] })
    await revisor.onOther({ key: chave(MILTON), text: PR })
    await esperar()
    assert.ok(!chamadas.some((c) => c.args[1] === 'merge'))
    assert.match(enviados.at(-1).texto, motivo)
  })
}

test('commit novo entre a revisão e o merge: não mergeia', async () => {
  const { revisor, chamadas, enviados, esperar } = montar({ revisao: LIMPA, views: [{}, { headRefOid: 'ccccccc3' }] })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.args[1] === 'merge'))
  assert.match(enviados.at(-1).texto, /commit novo/)
})

test('CI pendente: espera terminar antes de revisar', async () => {
  const PEND = [{ __typename: 'CheckRun', name: 'Backend', status: 'IN_PROGRESS', conclusion: null }]
  const { revisor, chamadas, esperar } = montar({ revisao: LIMPA, views: [{ statusCheckRollup: PEND }, { statusCheckRollup: PEND }, {}] })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.match(chamadas.find((c) => c.bin === 'claude').input, /CI: todo verde/)
  assert.ok(chamadas.some((c) => c.args[1] === 'merge'))
})

test('CI que não termina no prazo: revisa, mas não mergeia', async () => {
  const PEND = [{ __typename: 'CheckRun', name: 'Backend', status: 'IN_PROGRESS', conclusion: null }]
  const { revisor, chamadas, enviados, esperar } = montar({ revisao: LIMPA, views: [{ statusCheckRollup: PEND }] })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.match(chamadas.find((c) => c.bin === 'claude').input, /CI: ainda rodando/)
  assert.ok(!chamadas.some((c) => c.args[1] === 'merge'))
  assert.match(enviados.at(-1).texto, /CI ainda não terminou/)
})

test('mesmo commit já revisado limpo: só tenta o merge, sem revisar de novo', async () => {
  const anteriores = [{ commit_id: 'bbbbbbb2', submitted_at: '2026-11-11T15:00:00Z', body: `ok\n\n${marca({ bloqueadores: 0, maiores: 0, limpo: true })}` }]
  const { revisor, chamadas, esperar } = montar({ anteriores })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  assert.ok(!chamadas.some((c) => c.bin === 'claude'))
  assert.ok(chamadas.some((c) => c.args[1] === 'merge'))
})

test('com clone: revisa num worktree do head do PR, com regras da base, roteiro e diff em arquivo', async () => {
  const p = projetos({ 'my-solvers': { remote: 'git@github.com:Solvers-it/my-solvers.git', branch: 'main', regras: 'Regra do clone.' } })
  const wt = mkdtempSync(join(tmpdir(), 'wt-'))
  const roteiros = mkdtempSync(join(tmpdir(), 'rot-'))
  writeFileSync(join(roteiros, 'solvers-it.md'), '- uid_tenant em todo statement')
  const { revisor, chamadas, esperar } = montar({ ...p, worktreesDir: wt, checklistsDir: roteiros, revisao: SUJA })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()

  const fetch = chamadas.find((c) => c.bin === 'git' && c.args.includes('fetch'))
  assert.ok(fetch.args.includes('https://github.com/Solvers-it/my-solvers.git'))
  assert.ok(fetch.args.includes('+refs/pull/42/head:refs/claude-wpp/solvers-it-my-solvers-42-head'))
  assert.ok(fetch.args.includes('+refs/heads/develop:refs/claude-wpp/solvers-it-my-solvers-42-base'))
  const add = chamadas.find((c) => c.bin === 'git' && c.args[2] === 'worktree' && c.args[3] === 'add')
  assert.deepEqual(add.args.slice(3), ['add', '--detach', join(wt, 'solvers-it-my-solvers-42'), 'bbbbbbb2'])

  const input = chamadas.find((c) => c.bin === 'claude').input
  assert.match(input, /checkout do próprio PR/)
  assert.match(input, /Regra da base\./)
  assert.doesNotMatch(input, /Regra do clone/)
  assert.match(input, /uid_tenant em todo statement/)
  assert.match(input, /\+do worktree/)
  const claude = chamadas.find((c) => c.bin === 'claude')
  assert.equal(claude.cwd, join(wt, 'solvers-it-my-solvers-42'))
  assert.equal(claude.diffNoDisco, 'diff --git a/w b/w\n+do worktree')
  assert.equal(existsSync(join(wt, 'solvers-it-my-solvers-42')), false)

  const removidos = chamadas.filter((c) => c.bin === 'git' && c.args[2] === 'worktree' && c.args[3] === 'remove')
  assert.ok(removidos.length >= 2, 'limpa antes e depois')
  assert.ok(chamadas.filter((c) => c.bin === 'git' && c.args[2] === 'update-ref').length >= 4)
})

test('fetch do PR falhou: segue no clone como antes', async () => {
  const p = projetos({ 'my-solvers': { remote: 'git@github.com:Solvers-it/my-solvers.git', branch: 'main', regras: 'Regra do clone.' } })
  const { revisor, chamadas, esperar } = montar({ ...p, worktreesDir: mkdtempSync(join(tmpdir(), 'wt-')), falhaFetch: true })
  await revisor.onOther({ key: chave(MILTON), text: PR })
  await esperar()
  const claude = chamadas.find((c) => c.bin === 'claude')
  assert.ok(claude.args.includes('--restricted'))
  assert.match(claude.input, /Regra do clone/)
  assert.ok(chamadas.some((c) => c.args[1] === 'review'))
})

test('auxiliares de veredito, marca e CI', () => {
  assert.deepEqual(lerVeredito(LIMPA).veredito, { bloqueadores: 0, maiores: 0 })
  assert.equal(lerVeredito(LIMPA).limpo, true)
  assert.doesNotMatch(lerVeredito(LIMPA).texto, /VEREDITO/)
  assert.equal(lerVeredito('x\nVEREDITO: {"bloqueadores": "0", "maiores": 0}').limpo, false)
  assert.deepEqual(lerMarca(`a ${marca({ bloqueadores: 2, maiores: 1, limpo: false })}`), { bloqueadores: 2, maiores: 1, limpo: false })
  assert.equal(lerMarca('sem marca'), null)
  assert.equal(estadoCi([]).estado, 'sem-ci')
  assert.equal(estadoCi([{ __typename: 'StatusContext', context: 'ci', state: 'SUCCESS' }, { __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'SKIPPED' }]).estado, 'verde')
  assert.equal(estadoCi([{ __typename: 'StatusContext', context: 'ci', state: 'PENDING' }]).estado, 'pendente')
  assert.equal(estadoCi([{ __typename: 'CheckRun', name: 'x', status: 'COMPLETED', conclusion: 'CANCELLED' }]).estado, 'vermelho')
})
