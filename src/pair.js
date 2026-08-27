import { loadConfig } from './config.js'
import { createWhatsapp, aceitaDoBot, aceitaTudo } from './whatsapp.js'

const config = loadConfig()
const pessoal = process.argv[2] === 'me'

if (pessoal && !config.personalNumber) {
  console.error('Falta `personalNumber` no config.json — é a sua conta, a que o Claude vai operar.')
  process.exit(1)
}

const alvo = pessoal
  ? { authDir: config.personalAuthDir, numero: config.personalNumber, label: 'pessoal', accept: aceitaTudo }
  : { authDir: config.botAuthDir, numero: config.botNumber, label: 'bot', accept: (k) => aceitaDoBot(k, config.authorizedNumber) }

const whatsapp = createWhatsapp({
  authDir: alvo.authDir,
  accept: alvo.accept,
  onMessage: async () => {},
  label: alvo.label,
  log: console,
})

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

await whatsapp.connect()

console.log(`Pareado. As credenciais ficaram em ${alvo.authDir}`)
console.log('Agora reinicie o serviço: systemctl --user restart claude-wpp')
process.exit(0)
