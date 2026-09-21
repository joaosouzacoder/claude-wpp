import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createApi, mimetypeDe, decodificarBase64, nomeDeArquivoValido } from '../src/api.js'
import { openDb } from '../src/db.js'
import { createOutbox } from '../src/outbox.js'
import { createNotifier } from '../src/notify.js'
import { createCapture } from '../src/capture.js'
import { createContactResolver } from '../src/contacts.js'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const enviados = []
const documentos = []
const whatsapp = {
  sendText: async (to, text) => { enviados.push({ to, text }) },
  sendDocument: async (to, doc) => { documentos.push({ to, ...doc }) },
  state: () => 'open',
}

let api
let base

before(async () => {
  api = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp, sessionCount: () => 2 })
  const porta = await api.listen()
  base = `http://127.0.0.1:${porta}`
})

after(async () => { await api.close() })

test('healthz não exige token', async () => {
  const r = await fetch(`${base}/healthz`)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, wa: 'open', sessions: 2 })
})

test('send sem token é 401', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi' }),
  })
  assert.equal(r.status, 401)
})

test('send com token errado é 401', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer errado' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi' }),
  })
  assert.equal(r.status, 401)
})

test('send válido entrega a mensagem', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi' }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true })
  assert.deepEqual(enviados.at(-1), { to: '5511911111111', text: 'oi' })
})

test('send sem campos obrigatórios é 400', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ to: '5511911111111' }),
  })
  assert.equal(r.status, 400)
})

test('send com json inválido é 400', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: '{ nao e json',
  })
  assert.equal(r.status, 400)
})

test('rota desconhecida é 404', async () => {
  const r = await fetch(`${base}/qualquer`)
  assert.equal(r.status, 404)
})

test('GET em /send é 405', async () => {
  const r = await fetch(`${base}/send`)
  assert.equal(r.status, 405)
})

// --- POST /outbox: o único caminho do claude para a sua conta pessoal ---

let apiOut, baseOut, outbox
const avisos = []

before(async () => {
  const db = openDb(':memory:')
  outbox = createOutbox({ db, now: () => 1000 })
  apiOut = createApi({
    host: '127.0.0.1', port: 0, token: 'segredo', whatsapp,
    outbox, onDraft: async (job) => { avisos.push(job) },
  })
  baseOut = `http://127.0.0.1:${await apiOut.listen()}`
})

after(async () => { await apiOut.close() })

const propor = (corpo, token = 'segredo') => fetch(`${baseOut}/outbox`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(corpo),
})

test('outbox sem token é 401', async () => {
  assert.equal((await propor({ chatJid: '5@s.whatsapp.net', body: 'oi' }, 'errado')).status, 401)
})

test('rascunho criado nasce pendente e nunca é enviado sozinho', async () => {
  const antes = enviados.length
  const r = await propor({ chatJid: '5@s.whatsapp.net', chatName: 'Jane', body: 'traz o macbook' })
  assert.equal(r.status, 200)
  const { ok, id } = await r.json()
  assert.equal(ok, true)
  assert.equal(outbox.get(id).status, 'pending')
  assert.equal(enviados.length, antes)
})

test('criar rascunho avisa o dono, senão ele nunca saberia que existe', async () => {
  const antes = avisos.length
  await propor({ chatJid: '5@s.whatsapp.net', body: 'oi' })
  assert.equal(avisos.length, antes + 1)
})

test('rascunho inválido é 400 com o motivo', async () => {
  const r = await propor({ chatJid: '', body: 'oi' })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /destino/)
})

test('condicional sem verificação é recusada', async () => {
  const r = await propor({ chatJid: '5@s.whatsapp.net', body: 'oi', kind: 'conditional' })
  assert.equal(r.status, 400)
})

test('agendamento guarda a hora marcada', async () => {
  const r = await propor({ chatJid: '5@s.whatsapp.net', body: 'oi', scheduledFor: 1756382400 })
  const { id } = await r.json()
  assert.equal(outbox.get(id).scheduled_for, 1756382400)
})

test('sem conta pessoal ligada, /outbox responde 503 em vez de fingir', async () => {
  const semOutbox = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp })
  const porta = await semOutbox.listen()
  const r = await fetch(`http://127.0.0.1:${porta}/outbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ chatJid: '5@s.whatsapp.net', body: 'oi' }),
  })
  assert.equal(r.status, 503)
  await semOutbox.close()
})

// --- POST /wpp: a mesma porta do /wpp digitado no WhatsApp, de outra máquina ---

let apiWpp, baseWpp
const pedidos = []
let travar = null

before(async () => {
  apiWpp = createApi({
    host: '127.0.0.1', port: 0, token: 'segredo', whatsapp,
    onWpp: (pedido) => { pedidos.push(pedido); return travar },
  })
  baseWpp = `http://127.0.0.1:${await apiWpp.listen()}`
})

after(async () => { await apiWpp.close() })

const pedir = (corpo, token = 'segredo') => fetch(`${baseWpp}/wpp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify(corpo),
})

test('wpp sem token é 401', async () => {
  assert.equal((await pedir({ request: 'oi' }, 'errado')).status, 401)
})

test('wpp aceita o pedido e o entrega inteiro', async () => {
  const r = await pedir({ request: 'responde o Fulano que a migração atrasou' })
  assert.equal(r.status, 202)
  assert.deepEqual(await r.json(), { ok: true, queued: true })
  assert.equal(pedidos.at(-1), 'responde o Fulano que a migração atrasou')
})

test('wpp sem request é 400', async () => {
  assert.equal((await pedir({ request: '   ' })).status, 400)
})

test('wpp com json inválido é 400', async () => {
  const r = await fetch(`${baseWpp}/wpp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: '{ nao e json',
  })
  assert.equal(r.status, 400)
})

test('GET em /wpp é 405', async () => {
  assert.equal((await fetch(`${baseWpp}/wpp`)).status, 405)
})

// Uma rodada do Claude leva o tempo que levar e responde no WhatsApp. Se a
// resposta HTTP esperasse por ela, todo pedido de verdade morreria em timeout.
test('wpp responde sem esperar a rodada terminar', async () => {
  travar = new Promise(() => {})
  const r = await pedir({ request: 'algo demorado' })
  assert.equal(r.status, 202)
  travar = null
})

test('sem conta pessoal ligada, /wpp responde 503 em vez de fingir', async () => {
  const semWpp = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp })
  const porta = await semWpp.listen()
  const r = await fetch(`http://127.0.0.1:${porta}/wpp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ request: 'oi' }),
  })
  assert.equal(r.status, 503)
  await semWpp.close()
})

async function subirComNotificador({ send }) {
  const alertas = []
  const notifier = createNotifier({
    send: send ?? (async (texto) => { alertas.push(texto) }),
    dedupMs: 60_000,
  })
  const servidor = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp, notifier })
  const porta = await servidor.listen()
  const notificar = (corpo, token = 'segredo') => fetch(`http://127.0.0.1:${porta}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(corpo),
  })
  return { servidor, notificar, alertas }
}

test('notify entrega ao dono com a origem marcada', async () => {
  const { servidor, notificar, alertas } = await subirComNotificador({})
  const r = await notificar({ text: 'disco em 91%', source: 'srv1' })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, sent: true, deduped: false })
  assert.deepEqual(alertas, ['🔔 [srv1] disco em 91%'])
  await servidor.close()
})

test('notify com a mesma key dentro da janela não repete', async () => {
  const { servidor, notificar, alertas } = await subirComNotificador({})
  await notificar({ text: 'CI quebrou', key: 'ci-main' })
  const r = await notificar({ text: 'CI quebrou', key: 'ci-main' })
  assert.deepEqual(await r.json(), { ok: true, sent: false, deduped: true })
  assert.equal(alertas.length, 1)
  await servidor.close()
})

test('notify exige token', async () => {
  const { servidor, notificar, alertas } = await subirComNotificador({})
  assert.equal((await notificar({ text: 'x' }, null)).status, 401)
  assert.equal((await notificar({ text: 'x' }, 'errado')).status, 401)
  assert.equal(alertas.length, 0)
  await servidor.close()
})

test('notify sem text, ou com text que não é string, é 400', async () => {
  const { servidor, notificar, alertas } = await subirComNotificador({})
  assert.equal((await notificar({ source: 'srv1' })).status, 400)
  assert.equal((await notificar({ text: '   ' })).status, 400)
  assert.equal((await notificar({ text: 42 })).status, 400)
  assert.equal(alertas.length, 0)
  await servidor.close()
})

test('notify com o whatsapp fora do ar é 502, não 200', async () => {
  const { servidor, notificar } = await subirComNotificador({ send: async () => { throw new Error('WhatsApp não está conectado') } })
  const r = await notificar({ text: 'x' })
  assert.equal(r.status, 502)
  assert.match((await r.json()).error, /não está conectado/)
  await servidor.close()
})

test('notify sem notificador configurado é 503', async () => {
  const r = await fetch(`${base}/notify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ text: 'x' }),
  })
  assert.equal(r.status, 503)
})

const enviarArquivo = (corpo, { token = 'segredo', url = base } = {}) => fetch(`${url}/send-file`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
})

// Bytes that are not valid UTF-8: a binary file has to arrive untouched.
const BINARIO = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x0a])

test('send-file entrega o arquivo byte a byte, com o mimetype pela extensão', async () => {
  const r = await enviarArquivo({ to: '5511911111111', fileName: 'relatorio.pdf', content: BINARIO.toString('base64'), caption: 'segue' })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, bytes: BINARIO.length })
  const doc = documentos.at(-1)
  assert.equal(doc.to, '5511911111111')
  assert.ok(Buffer.isBuffer(doc.content) && doc.content.equals(BINARIO), 'bytes intactos')
  assert.equal(doc.fileName, 'relatorio.pdf')
  assert.equal(doc.mimetype, 'application/pdf')
  assert.equal(doc.caption, 'segue')
})

test('send-file respeita um mimetype explícito', async () => {
  await enviarArquivo({ to: '5511911111111', fileName: 'dados', content: BINARIO.toString('base64'), mimetype: 'application/x-custom' })
  assert.equal(documentos.at(-1).mimetype, 'application/x-custom')
})

test('send-file exige token, e sem ele nem lê o corpo', async () => {
  const antes = documentos.length
  assert.equal((await enviarArquivo({ to: '5511911111111', fileName: 'a.txt', content: 'b2k=' }, { token: null })).status, 401)
  assert.equal((await enviarArquivo({ to: '5511911111111', fileName: 'a.txt', content: 'b2k=' }, { token: 'errado' })).status, 401)
  assert.equal(documentos.length, antes)
})

test('send-file recusa nome com caminho, base64 inválido e destino vazio', async () => {
  const antes = documentos.length
  const casos = [
    { to: '5511911111111', fileName: '../../etc/passwd', content: 'b2k=' },
    { to: '5511911111111', fileName: 'a\\b.txt', content: 'b2k=' },
    { to: '5511911111111', fileName: '..', content: 'b2k=' },
    { to: '5511911111111', fileName: '', content: 'b2k=' },
    { to: '5511911111111', fileName: 'a.txt', content: 'isto não é base64!' },
    { to: '5511911111111', fileName: 'a.txt', content: '' },
    { fileName: 'a.txt', content: 'b2k=' },
  ]
  for (const corpo of casos) {
    const r = await enviarArquivo(corpo)
    assert.equal(r.status, 400, JSON.stringify(corpo))
  }
  assert.equal(documentos.length, antes)
})

test('send-file acima do limite responde 413 em vez de derrubar a conexão', async () => {
  const gigante = JSON.stringify({ to: '5511911111111', fileName: 'a.bin', content: 'A'.repeat(25 * 1024 * 1024) })
  const r = await enviarArquivo(gigante)
  assert.equal(r.status, 413)
  assert.match((await r.json()).error, /grande demais/)
})

test('send-file com o whatsapp fora do ar é 502', async () => {
  const falho = createApi({
    host: '127.0.0.1', port: 0, token: 'segredo',
    whatsapp: { ...whatsapp, sendDocument: async () => { throw new Error('WhatsApp não está conectado') } },
  })
  const porta = await falho.listen()
  const r = await enviarArquivo({ to: '5511911111111', fileName: 'a.txt', content: 'b2k=' }, { url: `http://127.0.0.1:${porta}` })
  assert.equal(r.status, 502)
  await falho.close()
})

test('mimetypeDe cobre os formatos comuns e cai no genérico', () => {
  assert.equal(mimetypeDe('a.PDF'), 'application/pdf')
  assert.equal(mimetypeDe('foto.jpg'), 'image/jpeg')
  assert.equal(mimetypeDe('planilha.xlsx'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  assert.equal(mimetypeDe('sem-extensao'), 'application/octet-stream')
})

test('decodificarBase64 aceita quebra de linha e recusa lixo', () => {
  assert.equal(decodificarBase64('b2k=').toString(), 'oi')
  assert.equal(decodificarBase64('b2\nk=').toString(), 'oi', 'base64 com quebra de linha, como o `base64` sem -w0 gera')
  assert.equal(decodificarBase64('b2k'), null)
  assert.equal(decodificarBase64('!!!!'), null)
  assert.equal(decodificarBase64(42), null)
})

test('nomeDeArquivoValido só aceita nome, nunca caminho', () => {
  assert.equal(nomeDeArquivoValido('relatório final.pdf'), true)
  assert.equal(nomeDeArquivoValido('a/b.pdf'), false)
  assert.equal(nomeDeArquivoValido('x'.repeat(201)), false)
})

async function subirComAgenda() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), 'api-contatos-')), 'wpp.db'))
  const capture = createCapture({ db })
  capture.rememberChat({ jid: '5511911111111@s.whatsapp.net', name: 'Fulano Bailāo', kind: 'dm' })
  capture.rememberChat({ jid: '5511922222222@s.whatsapp.net', name: 'Fulano Peters', kind: 'dm' })
  const texto = []
  const docs = []
  const wa = {
    sendText: async (to, text) => { texto.push({ to, text }) },
    sendDocument: async (to, doc) => { docs.push({ to, ...doc }) },
    state: () => 'open',
  }
  const servidor = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp: wa, contacts: createContactResolver(db) })
  const url = `http://127.0.0.1:${await servidor.listen()}`
  const post = (rota, corpo) => fetch(`${url}${rota}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify(corpo),
  })
  return { servidor, post, texto, docs }
}

test('send-file por nome resolve o contato e diz para quem foi', async () => {
  const { servidor, post, docs } = await subirComAgenda()
  const r = await post('/send-file', { to: 'fulano bailão', fileName: 'handoff.md', content: 'b2k=' })
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true, bytes: 2, to: 'Fulano Bailāo' })
  assert.equal(docs.at(-1).to, '5511911111111@s.whatsapp.net')
  await servidor.close()
})

test('send por nome também resolve', async () => {
  const { servidor, post, texto } = await subirComAgenda()
  const r = await post('/send', { to: 'Peters', text: 'oi' })
  assert.deepEqual(await r.json(), { ok: true, to: 'Fulano Peters' })
  assert.equal(texto.at(-1).to, '5511922222222@s.whatsapp.net')
  await servidor.close()
})

test('nome ambíguo é 409 com os candidatos, e nada sai', async () => {
  const { servidor, post, docs } = await subirComAgenda()
  const r = await post('/send-file', { to: 'Fulano', fileName: 'a.txt', content: 'b2k=' })
  assert.equal(r.status, 409)
  assert.deepEqual((await r.json()).candidates.sort(), ['Fulano Bailāo', 'Fulano Peters'])
  assert.equal(docs.length, 0)
  await servidor.close()
})

test('nome que não existe é 404, e nada sai', async () => {
  const { servidor, post, texto } = await subirComAgenda()
  const r = await post('/send', { to: 'Beltrano', text: 'oi' })
  assert.equal(r.status, 404)
  assert.equal(texto.length, 0)
  await servidor.close()
})

async function subirComRascunhos() {
  const dir = mkdtempSync(join(tmpdir(), 'api-rascunho-'))
  const db = openDb(join(dir, 'wpp.db'))
  createCapture({ db }).rememberChat({ jid: '5511911111111@s.whatsapp.net', name: 'Fulano Bailāo', kind: 'dm' })
  const outboxReal = createOutbox({ db })
  const avisados = []
  const saiu = []
  const wa = {
    sendText: async (...a) => { saiu.push(a) },
    sendDocument: async (...a) => { saiu.push(a) },
    state: () => 'open',
  }
  const servidor = createApi({
    host: '127.0.0.1', port: 0, token: 'segredo', whatsapp: wa,
    outbox: outboxReal, onDraft: (r) => { avisados.push(r) },
    contacts: createContactResolver(db), mediaDir: join(dir, 'media'),
  })
  const url = `http://127.0.0.1:${await servidor.listen()}`
  const post = (rota, corpo) => fetch(`${url}${rota}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify(corpo),
  })
  return { servidor, post, outboxReal, avisados, saiu }
}

test('send-file com confirm vira rascunho com anexo, e nada sai antes do seu ok', async () => {
  const { servidor, post, outboxReal, avisados, saiu } = await subirComRascunhos()
  const r = await post('/send-file', { to: 'Beltrano', fileName: 'x', content: 'b2k=', confirm: true })
  assert.equal(r.status, 404, 'nome errado continua 404 mesmo com confirm')

  const ok = await post('/send-file', { to: 'fulano bailão', fileName: 'handoff.md', content: Buffer.from('# oi\n').toString('base64'), caption: 'segue', confirm: true })
  assert.equal(ok.status, 202)
  const corpo = await ok.json()
  assert.deepEqual(corpo, { ok: true, draft: corpo.draft, to: 'Fulano Bailāo' })

  const d = outboxReal.get(corpo.draft)
  assert.equal(d.status, 'pending')
  assert.equal(d.chat_jid, '5511911111111@s.whatsapp.net')
  assert.equal(d.body, 'segue')
  assert.equal(d.attachment_name, 'handoff.md')
  assert.equal(d.attachment_mimetype, 'text/markdown')
  assert.equal(readFileSync(d.attachment_path, 'utf8'), '# oi\n', 'o arquivo ficou guardado para sair depois')
  assert.equal(avisados.length, 1, 'o dono recebe o rascunho para decidir')
  assert.equal(saiu.length, 0, 'nada saiu')
  await servidor.close()
})

test('send com confirm vira rascunho de texto', async () => {
  const { servidor, post, outboxReal, saiu } = await subirComRascunhos()
  const r = await post('/send', { to: '5511911111111', text: 'oi', confirm: true })
  assert.equal(r.status, 202)
  const d = outboxReal.get((await r.json()).draft)
  assert.equal(d.chat_jid, '5511911111111@s.whatsapp.net')
  assert.equal(d.body, 'oi')
  assert.equal(saiu.length, 0)
  await servidor.close()
})

test('confirm sem conta pessoal é 503, não um envio direto', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ to: '5511911111111', text: 'oi', confirm: true }),
  })
  assert.equal(r.status, 503)
})

test('nome sem conta pessoal configurada explica que precisa do número', async () => {
  const r = await fetch(`${base}/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' },
    body: JSON.stringify({ to: 'Fulano', text: 'oi' }),
  })
  assert.equal(r.status, 400)
  assert.match((await r.json()).error, /conta pessoal/)
})

async function subirParaCompor() {
  const dir = mkdtempSync(join(tmpdir(), 'api-compor-'))
  const mediaDir = join(dir, 'media')
  mkdirSync(mediaDir, { recursive: true })
  const db = openDb(join(dir, 'wpp.db'))
  const outboxReal = createOutbox({ db })
  const pedidos = []
  const servidor = createApi({ host: '127.0.0.1', port: 0, token: 'segredo', whatsapp, outbox: outboxReal, onWpp: (p) => { pedidos.push(p) }, mediaDir })
  const url = `http://127.0.0.1:${await servidor.listen()}`
  const post = (rota, corpo) => fetch(`${url}${rota}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer segredo' }, body: JSON.stringify(corpo) })
  return { servidor, post, outboxReal, pedidos, dir, mediaDir }
}

test('outbox guarda as duas versões do texto', async () => {
  const { servidor, post, outboxReal } = await subirParaCompor()
  const r = await post('/outbox', { chatJid: '5511911111111@s.whatsapp.net', body: 'fala ju', bodyBot: 'Olá, Juliano.' })
  const d = outboxReal.get((await r.json()).id)
  assert.equal(d.body, 'fala ju')
  assert.equal(d.body_bot, 'Olá, Juliano.')
  await servidor.close()
})

test('outbox só aceita anexo de dentro da pasta de mídia, nem por symlink escapa', async () => {
  const { servidor, post, outboxReal, dir, mediaDir } = await subirParaCompor()
  const fora = join(dir, 'segredo.txt')
  writeFileSync(fora, 'não pode sair')
  symlinkSync(fora, join(mediaDir, 'atalho.txt'))
  const dentro = join(mediaDir, '123-handoff.md')
  writeFileSync(dentro, '# ok')
  const base = { chatJid: '5511911111111@s.whatsapp.net', body: 'segue', bodyBot: 'Segue.' }
  for (const path of [fora, join(mediaDir, 'atalho.txt'), join(mediaDir, '..', 'segredo.txt'), '/etc/passwd', join(mediaDir, 'nao-existe')]) {
    const r = await post('/outbox', { ...base, attachment: { path, name: 'x.txt' } })
    assert.equal(r.status, 400, path)
  }
  const ok = await post('/outbox', { ...base, attachment: { path: dentro, name: 'handoff.md' } })
  assert.equal(ok.status, 200)
  const d = outboxReal.get((await ok.json()).id)
  assert.equal(d.attachment_name, 'handoff.md')
  assert.equal(d.attachment_mimetype, 'text/markdown')
  await servidor.close()
})

test('wpp com arquivo guarda o arquivo e diz ao agente como anexar', async () => {
  const { servidor, post, pedidos, mediaDir } = await subirParaCompor()
  const r = await post('/wpp', { request: 'manda o handoff pro Fulano', attachment: { fileName: 'handoff.md', content: Buffer.from('# oi').toString('base64') } })
  assert.equal(r.status, 202)
  assert.equal(pedidos.length, 1)
  assert.match(pedidos[0], /^manda o handoff pro Fulano/)
  const caminho = pedidos[0].match(/--attach '([^']+)'/)[1]
  assert.ok(caminho.startsWith(mediaDir))
  assert.equal(readFileSync(caminho, 'utf8'), '# oi')
  assert.match(pedidos[0], /--attach-name 'handoff\.md'/)
  await servidor.close()
})

test('wpp com anexo inválido é 400 e não chega ao agente', async () => {
  const { servidor, post, pedidos } = await subirParaCompor()
  assert.equal((await post('/wpp', { request: 'x', attachment: { fileName: '../a', content: 'b2k=' } })).status, 400)
  assert.equal((await post('/wpp', { request: 'x', attachment: { fileName: 'a.txt', content: 'lixo!' } })).status, 400)
  assert.equal(pedidos.length, 0)
  await servidor.close()
})
