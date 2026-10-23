import { renameSync, existsSync } from 'node:fs'
import { loadConfig } from './config.js'
import { createWhatsapp, aceitaDoBot, aceitaTudo, credenciaisGravadas, MIDIAS_ARQUIVADAS } from './whatsapp.js'
import { openDb } from './db.js'
import { createCapture } from './capture.js'

const config = loadConfig()
const pessoal = process.argv[2] === 'me'

if (pessoal && !config.personalNumber) {
  console.error('Falta `personalNumber` no config.json — é a sua conta, a que o Claude vai operar.')
  process.exit(1)
}

const alvo = pessoal
  ? { authDir: config.personalAuthDir, numero: config.personalNumber, label: 'pessoal', accept: aceitaTudo }
  : { authDir: config.botAuthDir, numero: config.botNumber, label: 'bot', accept: (k) => aceitaDoBot(k, config.authorizedNumber) }

// WhatsApp replays recent history exactly once, into whichever process links the
// device. That process is this one — the daemon reconnecting later is handed
// nothing. So pairing the personal account has to record, or the log starts
// empty and the first weeks of context are gone for good.
let capture = null
let gravadas = 0
let ultima = Date.now()

if (pessoal) {
  capture = createCapture({ db: openDb(config.dbPath) })
}

const registrar = (msg, media = null) => {
  if (!capture) return
  if (capture.record(msg, { mediaPath: msg?.key?.fromMe ? null : (media?.path ?? null) })) {
    gravadas += 1
    ultima = Date.now()
  }
}

function montar() {
  return createWhatsapp({
    authDir: alvo.authDir,
    accept: alvo.accept,
    // The personal account archives what arrives while it pairs, exactly as
    // the daemon does afterwards (see montarContaPessoal). The bot has no
    // capture here, so a download would only be thrown away.
    downloadMedia: pessoal,
    mediaDir: config.personalMediaDir,
    mediaKinds: MIDIAS_ARQUIVADAS,
    maxMediaBytes: config.personalMediaMaxBytes,
    entregarSemConteudo: true,
    onMessage: async ({ raw, media }) => registrar(raw, media),
    onHistory: pessoal ? (mensagens) => {
      for (const m of mensagens) registrar(m)
      console.log(`  ...${gravadas} mensagem(ns) gravada(s)`)
    } : undefined,
    onChats: pessoal ? (chats) => {
      for (const c of chats) capture.rememberChat(c)
      ultima = Date.now()
    } : undefined,
    label: alvo.label,
    log: console,
  })
}

let whatsapp = montar()

// Unlinking the device on the phone leaves credentials behind that can only
// produce a 401. Resuming them shows no QR and looks like a freeze, so retire
// them and start the pairing over — keeping the old folder rather than deleting
// it, in case the wrong account was unlinked.
async function conectarPareando() {
  try {
    await whatsapp.connect()
  } catch (err) {
    if (!err.deslogado) throw err

    const aposentado = `${alvo.authDir}.morto-${Date.now()}`
    if (existsSync(alvo.authDir)) renameSync(alvo.authDir, aposentado)
    console.log()
    console.log('As credenciais guardadas já não valem — o aparelho foi desconectado no celular.')
    console.log(`Movi as antigas para ${aposentado} e vou parear do zero.`)
    console.log()

    whatsapp = montar()
    await whatsapp.connect()
  }
}

console.log(`Pareando a conta ${alvo.label} (${alvo.numero}).`)
console.log('No celular: WhatsApp > Aparelhos conectados > Conectar aparelho.')

if (pessoal) {
  console.log()
  console.log('Atenção: isto liga a SUA conta pessoal a uma biblioteca de automação,')
  console.log('o que contraria os Termos do WhatsApp. O risco de banimento é baixo,')
  console.log('mas não é zero, e a conta não é descartável. Leia o SECURITY.md.')
  console.log()
  console.log('A partir daqui, todas as suas conversas passam a ser gravadas em')
  console.log(config.dbPath)
  console.log()
}

await conectarPareando()

if (pessoal) {
  console.log('Pareado. Recebendo o histórico — isso leva um minuto, não interrompa.')

  // The dump arrives in bursts with no reliable "that was the last one", so wait
  // for it to go quiet rather than for a signal that may never come.
  const QUIETO_MS = 20000
  const TETO_MS = 300000
  const comecou = Date.now()

  await new Promise((resolve) => {
    const timer = setInterval(() => {
      const parado = Date.now() - ultima > QUIETO_MS
      const estourou = Date.now() - comecou > TETO_MS
      if (parado || estourou) {
        clearInterval(timer)
        resolve()
      }
    }, 1000)
  })

  console.log(`Histórico gravado: ${gravadas} mensagem(ns).`)
}

if (!(await credenciaisGravadas(alvo.authDir))) {
  console.error(`As credenciais não ficaram gravadas em ${alvo.authDir}. Rode o pareamento de novo antes de reiniciar o serviço.`)
  process.exit(1)
}

console.log(`Pareado. As credenciais ficaram em ${alvo.authDir}`)
console.log('Agora reinicie o serviço: systemctl --user restart claude-wpp')
process.exit(0)
