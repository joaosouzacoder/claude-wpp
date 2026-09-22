// Turns what the owner says in plain words ("manda o 31 pelo bot", "descarta
// esse", "pede pro Luan o relatório") into the bot command it means. Anything
// that is not clearly a command answers NENHUM and goes on to the session as
// before — so a doubtful reading costs one normal prompt, never a wrong send.

const NENHUM = 'NENHUM'
// Long text is a prompt for the session, not an instruction to the bot.
export const MAX_CHARS_INTENCAO = 400

export function promptIntencao({ texto, ajuda, citada = null, pendentes = [] }) {
  const rascunhos = pendentes.length
    ? pendentes.map((p) => `#${p.id} para ${p.chat_name || p.chat_jid}: "${String(p.body ?? '').slice(0, 120)}"`).join('\n')
    : '(nenhum)'
  return [
    'Você traduz o que o dono de um bot de WhatsApp disse em linguagem natural para UM comando do bot.',
    '',
    'Comandos do bot:',
    ajuda,
    '',
    'Rascunhos pendentes agora:',
    rascunhos,
    ...(citada ? ['', 'Ele está citando esta mensagem do bot:', `"${citada.slice(0, 600)}"`] : []),
    '',
    'Regras:',
    `- Responda só uma linha: o comando exato (começando com /), ou ${NENHUM}.`,
    '- Pergunta sobre o próprio bot vira o comando que mostra aquilo: rascunhos/agendamentos → /schedulers, sessões → /ls, ajuda → /help.',
    '- "para", "cancela o que está rodando", "interrompe" → /stop.',
    `- ${NENHUM} para tarefa de programação, pergunta sobre código ou qualquer outro assunto, conversa, ou qualquer dúvida sobre a intenção.`,
    '- /ok, /bot, /no e /edit precisam de um número de rascunho: o que ele disse, o da mensagem citada, ou o único pendente. Sem isso, NENHUM.',
    '- "como eu", "da minha conta" é /ok; "pelo bot", "formal" é /bot.',
    '- Pedido para escrever, avisar, cobrar ou responder alguém no WhatsApp dele é /wpp seguido do pedido nas palavras dele.',
    '- Nunca invente número, nome ou texto que ele não disse.',
    '',
    'Exemplos:',
    '"manda o 4 pelo bot" → /bot 4',
    '"muda o 4 para: chego às 11h" → /edit 4 chego às 11h',
    '"avisa a Ana que a reunião mudou pra 15h" → /wpp avisa a Ana que a reunião mudou pra 15h',
    '"cobra o Pedro do relatório" → /wpp cobra o Pedro do relatório',
    '"o que tem pendente?" → /schedulers',
    '"corrige o bug do login" → NENHUM',
    '',
    'O que ele disse:',
    texto,
  ].join('\n')
}

// Only a known command survives; anything else — chatter, a made-up command,
// a multi-line essay — reads as "not a command".
export function lerIntencao(saida, conhecidos) {
  const linha = String(saida ?? '').trim().split('\n')[0].trim().replace(/^`+|`+$/g, '')
  if (!linha.startsWith('/')) return null
  const nome = linha.slice(1).split(/\s+/)[0]?.toLowerCase()
  return conhecidos.has(nome) ? linha : null
}

// Text quoted from one of the bot's own messages, when he answers one.
export function textoCitado(raw) {
  const q = raw?.message?.extendedTextMessage?.contextInfo?.quotedMessage
  return q?.conversation ?? q?.extendedTextMessage?.text ?? q?.documentMessage?.caption ?? null
}

const ENDPOINT = 'https://api.openai.com/v1/chat/completions'

// The same OpenAI key that already transcribes audio: a CLI `claude -p` spends
// over ten seconds just starting up, and this sits in front of every message.
export function classificadorOpenAI({ apiKey, model, timeoutMs, fetchImpl = fetch }) {
  return async (prompt) => {
    const resposta = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!resposta.ok) throw new Error(`a OpenAI respondeu ${resposta.status}`)
    const corpo = await resposta.json()
    return String(corpo?.choices?.[0]?.message?.content ?? '')
  }
}

export function createIntent({ classify, ajuda, conhecidos, log }) {
  return async function interpretar({ texto, citada, pendentes }) {
    if (!texto?.trim() || texto.length > MAX_CHARS_INTENCAO) return null
    let linha
    try {
      linha = lerIntencao(await classify(promptIntencao({ texto, ajuda, citada, pendentes })), conhecidos)
    } catch (err) {
      log?.warn?.(`[intent] classificação falhou, segue para a sessão: ${err.message}`)
      return null
    }
    return linha && rascunhoNomeado(linha, { texto, citada, pendentes }) ? linha : null
  }
}

const SOBRE_RASCUNHO = new Set(['ok', 'bot', 'no', 'edit'])

// A command that sends or discards a draft only runs on a draft he pointed
// at — by number, by quoting it, or by it being the only one pending. The
// model is told the same, but a guess here sends a message, so it is checked
// here too rather than trusted.
export function rascunhoNomeado(linha, { texto, citada, pendentes }) {
  const [nome, alvo] = linha.slice(1).split(/\s+/)
  if (!SOBRE_RASCUNHO.has(nome.toLowerCase())) return true
  const id = Number(String(alvo ?? '').replace(/[^0-9]/g, ''))
  if (!id) return false
  const dito = new RegExp(`(^|\\D)${id}(\\D|$)`)
  if (dito.test(texto)) return true
  if (citada && new RegExp(`#${id}(\\D|$)`).test(citada)) return true
  return pendentes.length === 1 && pendentes[0].id === id
}
