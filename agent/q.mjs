#!/usr/bin/env node
// Read-only query against the WhatsApp log.
//   node q.mjs "select * from chats where name like '%líder%'"
//   node q.mjs --json "select body from messages limit 5"
import { DatabaseSync } from 'node:sqlite'
import { loadConfig } from '../src/config.js'

const args = process.argv.slice(2)
const comoJson = args[0] === '--json'
const sql = (comoJson ? args.slice(1) : args).join(' ').trim()

if (!sql) {
  console.error('uso: node q.mjs [--json] "<select ...>"')
  process.exit(1)
}
if (!/^\s*(select|with)\b/i.test(sql)) {
  console.error('só leitura aqui. Para propor uma mensagem use propose.mjs.')
  process.exit(1)
}

const db = new DatabaseSync(loadConfig().dbPath, { readOnly: true })
const linhas = db.prepare(sql).all()

if (comoJson) {
  console.log(JSON.stringify(linhas, null, 2))
} else if (!linhas.length) {
  console.log('(nenhuma linha)')
} else {
  for (const l of linhas) {
    console.log(Object.entries(l).map(([k, v]) => `${k}=${v}`).join('\t'))
  }
  console.log(`(${linhas.length} linha(s))`)
}
db.close()
