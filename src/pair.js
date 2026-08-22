import { join } from 'node:path'
import { loadConfig } from './config.js'
import { createWhatsapp } from './whatsapp.js'

const config = loadConfig()

const whatsapp = createWhatsapp({
  authDir: join(config.stateDir, 'wa-auth'),
  authorizedNumber: config.authorizedNumber,
  onMessage: async () => {},
  log: console,
})

console.log(`Pareando o número do bot (${config.botNumber}).`)
console.log('No celular: WhatsApp > Aparelhos conectados > Conectar aparelho.')

await whatsapp.connect()

console.log('Pareado. As credenciais ficaram em', join(config.stateDir, 'wa-auth'))
console.log('Agora suba o serviço: systemctl --user start claude-wpp')
process.exit(0)
