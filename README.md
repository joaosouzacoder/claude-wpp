# claude-wpp

Claude Code pelo WhatsApp, com várias sessões paralelas, usando a subscription
já autenticada neste host. Não consome a API paga.

## Instalação

```bash
cd ~/claude-wpp
npm install
cp config.example.json config.json    # ponha o seu apiToken
./install.sh
sudo loginctl enable-linger "$USER"   # uma vez só
npm run pair                          # leia o QR com o número do bot
systemctl --user start claude-wpp
```

## Uso no WhatsApp

| Comando | Efeito |
|---|---|
| `/new [dir] [nome]` | cria a sessão e ativa |
| `/ls` | lista as sessões |
| `/use <nome>` | troca a sessão ativa |
| `/end [nome]` | encerra a sessão |
| `/stop` | interrompe o que a ativa está fazendo |
| `/help` | lista os comandos |
| `@nome texto` | manda pra outra sessão sem trocar a ativa |
| texto solto | vai pra sessão ativa |

Quando algo passa de 8 segundos, o bot responde `Trabalhando nisso.` uma vez e
depois manda o resultado. Toda resposta vem prefixada com `[nome-da-sessão]`,
porque com sessões paralelas elas chegam fora de ordem.

Exemplo:

```
/new ~/work/api api
> Sessão [api] criada em /home/user/work/api

lista os testes que falham
> Trabalhando nisso.
> [api] 3 testes falhando em auth_spec.rb...

@infra checa o disco do srv1
> [infra] /dev/sda1 em 81%
```

## API local

```bash
curl -X POST localhost:8787/send \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"to":"5511911111111","text":"oi"}'

curl localhost:8787/healthz
```

## Operação

```bash
systemctl --user status claude-wpp
journalctl --user -u claude-wpp -f
systemctl --user restart claude-wpp
```

O estado fica em `~/.local/state/claude-wpp/`. O histórico das conversas
pertence ao Claude Code, em `~/.claude/projects/` — reiniciar o serviço não
perde nenhuma sessão.

## Testes

```bash
npm test
```

## Aviso

O serviço roda o Claude com `--dangerously-skip-permissions` e diretório livre.
Quem tiver acesso ao WhatsApp autorizado executa comandos nesta máquina como o
seu usuário. Só o número configurado em `authorizedNumber` é atendido; qualquer
outro remetente é ignorado em silêncio.
