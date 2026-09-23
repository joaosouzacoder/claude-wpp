#!/usr/bin/env node
// The owner's calendar. The OAuth grant already lives on this host, held by
// `ortie`; this asks it for a fresh access token per run and never stores one.
//
//   node agenda.mjs ver [--dia hoje|amanhã|2026-09-24] [--ate 2026-09-30]
//   node agenda.mjs livre --dia amanhã [--de 09:00] [--ate 18:00] [--min 30]
//   node agenda.mjs buscar "1:1 milton" [--dia 2026-09-01] [--ate 2026-09-30]
//   node agenda.mjs criar --titulo "1:1" --quando "amanhã 14:00" [--dur 30] [--onde Meet] [--quem a@x,b@y] [--conta trabalho|pessoal]
//   node agenda.mjs mover --id <id> --quando "quinta 15:00" [--dur 60]
//   node agenda.mjs apagar --id <id>
//   node agenda.mjs responder --id <id> --resposta sim|não|talvez
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createCalendar, quandoEm, janelaDoDia, horariosLivres, horaLocal } from '../src/calendar.js'
import { loadConfig } from '../src/config.js'

const executar = promisify(execFile)
const TZ = loadConfig().timezone ?? 'America/Sao_Paulo'
const agora = () => Math.floor(Date.now() / 1000)

const [acao, ...resto] = process.argv.slice(2)
const pegar = (nome) => {
  const i = resto.indexOf(`--${nome}`)
  return i === -1 ? null : resto[i + 1]
}
const solto = resto.find((a) => !a.startsWith('--') && resto[resto.indexOf(a) - 1]?.startsWith('--') !== true)

const CONTAS = { trabalho: 'gmail-work', pessoal: 'gmail-personal' }
const conta = CONTAS[pegar('conta') ?? 'trabalho']
if (!conta) {
  console.error('--conta tem que ser trabalho ou pessoal')
  process.exit(1)
}

// `ortie` refreshes on its own; a dead grant is the one thing it cannot fix,
// and that is a sentence for the owner, not a stack trace.
async function token() {
  try {
    const { stdout } = await executar('ortie', ['-a', conta, '--log-level', 'off', 'token', 'show'], { timeout: 30000 })
    const t = stdout.trim()
    if (!t) throw new Error('veio vazio')
    return t
  } catch (err) {
    const texto = `${err.stderr ?? ''}${err.message ?? ''}`
    if (/InvalidGrant|expired|revoked/i.test(texto)) {
      throw new Error(`a autorização do Google para a conta ${conta} expirou ou foi revogada — o João precisa autorizar de novo`)
    }
    throw new Error(`não consegui um token para ${conta}: ${texto.slice(0, 160)}`)
  }
}

const cal = createCalendar({ token, timezone: TZ })

const linha = (e) => `${e.dia} ${e.quando}  ${e.titulo}${e.onde ? ` (${e.onde})` : ''}${e.convidados.length ? ` — com ${e.convidados.join(', ')}` : ''}  [${e.id}]`

function janela() {
  const dia = pegar('dia') ?? 'hoje'
  const inicio = janelaDoDia(dia, TZ, agora())
  const ate = pegar('ate') ? janelaDoDia(pegar('ate'), TZ, agora()).ate : inicio.ate
  return { de: inicio.de, ate }
}

try {
  if (acao === 'ver') {
    const { de, ate } = janela()
    const eventos = await cal.listar({ de, ate })
    if (!eventos.length) console.log('(nada na agenda nesse período)')
    for (const e of eventos) console.log(linha(e))
  } else if (acao === 'buscar') {
    const busca = solto ?? pegar('texto')
    if (!busca) {
      console.error('uso: node agenda.mjs buscar "texto" [--dia <início>] [--ate <fim>]')
      process.exit(1)
    }
    const de = pegar('dia') ? janelaDoDia(pegar('dia'), TZ, agora()).de : agora() - 30 * 86400
    const ate = pegar('ate') ? janelaDoDia(pegar('ate'), TZ, agora()).ate : agora() + 90 * 86400
    const eventos = await cal.listar({ de, ate, busca })
    if (!eventos.length) console.log('(não achei nenhum evento com isso)')
    for (const e of eventos) console.log(linha(e))
  } else if (acao === 'livre') {
    const dia = pegar('dia') ?? 'hoje'
    const de = quandoEm(`${dia} ${pegar('de') ?? '09:00'}`, TZ, agora()).inicio
    const ate = quandoEm(`${dia} ${pegar('ate') ?? '18:00'}`, TZ, agora()).inicio
    const eventos = await cal.listar({ de, ate })
    const livres = horariosLivres({ de, ate, eventos, minimoMin: Number(pegar('min') ?? 30) })
    if (!livres.length) console.log('(sem janela livre nesse intervalo)')
    for (const l of livres) console.log(`${horaLocal(l.de, TZ)}-${horaLocal(l.ate, TZ)}`)
  } else if (acao === 'criar') {
    const titulo = pegar('titulo')
    const quando = pegar('quando')
    if (!titulo || !quando) {
      console.error('uso: node agenda.mjs criar --titulo "..." --quando "amanhã 14:00" [--dur 30] [--onde ...] [--quem a@x,b@y]')
      process.exit(1)
    }
    const criado = await cal.criar({
      titulo,
      inicio: quandoEm(quando, TZ, agora()).inicio,
      duracaoMin: Number(pegar('dur') ?? 30),
      onde: pegar('onde'),
      descricao: pegar('desc'),
      convidados: (pegar('quem') ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    })
    console.log(`criado: ${linha(criado)}`)
  } else if (acao === 'mover') {
    const id = pegar('id')
    const quando = pegar('quando')
    if (!id || !quando) {
      console.error('uso: node agenda.mjs mover --id <id> --quando "quinta 15:00" [--dur 60]')
      process.exit(1)
    }
    const r = await cal.mover({ id, inicio: quandoEm(quando, TZ, agora()).inicio, duracaoMin: pegar('dur') ? Number(pegar('dur')) : null })
    console.log(`movido: ${linha(r.depois)}\nantes era: ${r.antes.dia} ${r.antes.quando}`)
  } else if (acao === 'apagar') {
    const id = pegar('id')
    if (!id) {
      console.error('uso: node agenda.mjs apagar --id <id>')
      process.exit(1)
    }
    const apagado = await cal.apagar({ id })
    console.log(`apaguei: ${linha(apagado)}`)
  } else if (acao === 'responder') {
    const id = pegar('id')
    const resposta = pegar('resposta')
    if (!id || !resposta) {
      console.error('uso: node agenda.mjs responder --id <id> --resposta sim|não|talvez')
      process.exit(1)
    }
    const r = await cal.responder({ id, resposta })
    console.log(`respondido (${r.minhaResposta}): ${linha(r)}`)
  } else {
    console.error(`uso: node agenda.mjs ver|buscar|livre|criar|mover|apagar|responder [...]
  --conta trabalho (padrão) | pessoal`)
    process.exit(1)
  }
} catch (err) {
  console.error(err.message)
  process.exit(1)
}
