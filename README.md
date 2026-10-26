# Concord

Plataforma de comunicação para um grupo pequeno de amigos: texto em tempo real, voz, compartilhamento de tela,
anexos e um app desktop leve.
Segue o plano em [Concord — Plano do Projeto](https://claude.ai/artifact/HccwfR8DZjjkgVYx1212Ay) e reproduz, em escala
menor, os três planos do Discord: **consultas** (REST), **tempo real** (gateway WebSocket) e **mídia** (WebRTC, Fase 3).

```
server/   Go: API REST + gateway WebSocket (net/http, coder/websocket, pgx)
web/      React + TypeScript + Vite, Zustand para estado
infra/    Docker Compose: PostgreSQL 17, Redis, LiveKit (SFU de voz) e RustFS (arquivos, S3)
desktop/  App desktop em Tauri 2 (Rust): bandeja, notificações, push-to-talk global
```

## Rodando em desenvolvimento

Pré-requisitos: Docker, Go 1.24+ e Node 22+.

```bash
docker compose -f infra/docker-compose.yml up -d
```

```bash
go -C server run ./cmd/concord
```

```bash
npm --prefix web install && npm --prefix web run dev
```

Abra http://localhost:5173. O Vite repassa `/api` e `/gateway` para o servidor em `:8080`.
O Postgres do Compose fica na porta **5433** e o Redis na **6380** do host, para não colidir com outros projetos.

Variáveis do servidor: `DATABASE_URL`, `REDIS_URL` (padrão `redis://localhost:6380/0`), `CONCORD_ADDR` (padrão `:8080`), `CONCORD_ORIGINS` (origens aceitas no
WebSocket, padrão `localhost:*,127.0.0.1:*`) e `CONCORD_WEB_DIR` (pasta do build do `web/` para servir tudo de um só
processo).

## O que já funciona (Fases 0, 1 e 2)

- Cadastro e login com senha argon2id; token de sessão aleatório guardado só como hash SHA-256
- Snowflake IDs de 64 bits (serializados como string no JSON)
- Servidores, canais de texto/voz, convites por link (`/invite/<código>`, expiram em 7 dias)
- Gateway com HELLO, IDENTIFY, READY (snapshot completo do estado), heartbeat e detecção de conexão zumbi
- **RESUME**: a sessão sobrevive 2 minutos a uma queda; o servidor reenvia os eventos perdidos pelo número de sequência
- Reconexão com backoff exponencial + jitter no cliente
- Mensagens via REST com entrega via gateway (`MESSAGE_CREATE`), **envio otimista com `nonce`**, falha com "tentar de novo"
- Histórico paginado por cursor (`before=<id>`), carregado ao rolar para cima
- Edição, exclusão e @menções com destaque
- **Não lidas persistentes** (`read_states`): o READY traz até onde você leu cada canal e quantas menções chegaram depois;
  abrir o canal envia um ack, e as suas outras abas recebem `MESSAGE_ACK` e se atualizam juntas
- Indicador de digitação e presença (online, ausente, não perturbar, "Jogando X")
- **Rate limit** com token bucket atômico (script Lua no Redis); a resposta é 429 com `retry_after`, e o cliente reenvia
  sozinho a mensagem quando o balde tiver ficha de novo
- Checagem de pertencimento em toda rota e em toda inscrição de tópico do gateway

| Balde | Chave | Limite |
| --- | --- | --- |
| Login | IP | 5 seguidas, depois 1 a cada 12 s |
| Cadastro | IP | 3 por hora |
| Mensagens | usuário | 5 seguidas, depois 1 por segundo |
| Outras escritas (servidor, canal, convite, edição) | usuário | 10 seguidas, depois 1 a cada 2 s |
| Conexões ao gateway | IP | 30 seguidas, depois 1 a cada 2 s |

Se o Redis cair, o limite é ignorado (fail open) em vez de derrubar o app. Atrás do Caddy, defina
`CONCORD_TRUST_PROXY=1` para o IP vir do `X-Forwarded-For`. Para zerar os limites em desenvolvimento:

```bash
docker exec concord-redis-1 redis-cli --scan --pattern "rl:*" | xargs docker exec -i concord-redis-1 redis-cli del
```

O menu do usuário (canto inferior esquerdo) tem **Simular queda de conexão**, para ver o RESUME acontecendo no DevTools.

## Voz (Fase 3)

Cada pessoa manda um único fluxo de áudio ao LiveKit (SFU), que o repassa aos outros sem decodificar.
O Concord decide **quem** está em qual call; o LiveKit só transporta a mídia.

1. O cliente envia pelo gateway o op 4 `VOICE_STATE_UPDATE` com `guild_id`, `channel_id`, `self_mute` e `self_deaf`.
2. O servidor confere se o canal é de voz e se a pessoa participa do servidor, guarda o estado em memória e
   avisa todos com o evento `VOICE_STATE_UPDATE`.
3. Só para a sessão que pediu, o servidor manda `VOICE_SERVER_UPDATE` com um token JWT do LiveKit (sala
   `voice:<canal>`, identidade `<usuário>:<sessão>`, só microfone e tela). Mudar só mute/deafen não gera token novo.
4. O navegador conecta direto ao LiveKit (WebRTC, Opus em perfil de voz com DTX e RED) e publica o microfone com
   supressão de ruído, cancelamento de eco e ganho automático do navegador.
5. Se alguém cai sem avisar, o webhook `participant_left` do LiveKit (assinado com o segredo da API) tira a pessoa
   da call em segundos. O webhook de uma sessão antiga não derruba a nova.

Na interface: clique no canal de voz para entrar; o painel "Voz conectada" mostra a qualidade da conexão e o botão
de desligar; microfone e fone ficam ao lado do seu nome; clique em alguém na call para ajustar o volume dessa
pessoa (0 a 200%, guardado no navegador). O anel verde de quem está falando é medido no próprio cliente com um
`AnalyserNode`, porque o evento de falantes do LiveKit só avisa mudanças e quem entrasse numa call em andamento não
veria quem já estava falando. Sem microfone (ou com a permissão negada), você entra só ouvindo.

O `livekit-client` (~530 kB) só é baixado na primeira vez que alguém entra numa call.

**Em produção**, o LiveKit precisa anunciar o IP público: defina `LIVEKIT_NODE_IP`, libere `7881/tcp` e `7882/udp`
no firewall e sirva o sinal por `wss://` (via Caddy) com `LIVEKIT_PUBLIC_URL`. Troque também `LIVEKIT_API_KEY` e
`LIVEKIT_API_SECRET` (o servidor Go e o Compose leem as mesmas variáveis) e aponte `LIVEKIT_WEBHOOK_URL` para
`/api/livekit/webhook`.

## Tela, anexos e app desktop (Fase 4)

**Compartilhamento de tela.** O botão de tela no painel "Voz conectada" compartilha uma janela ou a tela inteira, com
o áudio do jogo (no Chrome/Edge, marque "Compartilhar áudio" na janela de escolha). Sai em 1080p30 com simulcast em
360p e 720p: o LiveKit manda a camada que cabe no player e na internet de quem assiste. Quem está fora da call vê o
selo **AO VIVO** pelo gateway (`self_stream` no `VOICE_STATE_UPDATE`); quem está na call clica nele para assistir.
Como no Discord, a tela só é baixada por quem clica para assistir.

**Anexos.** Botão de clipe, colar (Ctrl+V) ou arrastar para o chat; até 10 arquivos de 25 MB por mensagem.

1. O cliente pede `POST /api/channels/{id}/attachments` e recebe uma URL pré-assinada (15 min).
2. O navegador envia o arquivo **direto ao armazenamento S3**, com barra de progresso; o servidor Go não carrega o arquivo.
3. Ao enviar a mensagem com `attachment_ids`, o servidor confere que o envio é do autor e do canal e ainda não foi usado,
   lê o arquivo para descobrir o tamanho e o tipo **reais** (não o que o cliente disse) e, se for imagem, gera a
   miniatura (até 400×300, JPEG ou PNG se tiver transparência).
4. Os arquivos são servidos pelo armazenamento, em outra origem; quem não é imagem é servido como download
   (`Content-Disposition: attachment`) e texto/HTML como `text/plain`, então nada enviado roda como página.

O plano previa MinIO, mas a imagem oficial saiu do Docker Hub em 2025; o Compose usa o **RustFS**, que fala a mesma
API S3. O servidor usa só a API S3 padrão, então dá para trocar por Cloudflare R2 ou AWS S3 mudando `S3_ENDPOINT`,
`S3_PUBLIC_ENDPOINT`, `S3_PUBLIC_URL`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET` e `S3_SECURE=1`. O console do
RustFS fica em http://localhost:9001 em desenvolvimento.

**App desktop (`desktop/`).** Uma casca Tauri 2 que abre o Concord hospedado, como o app do Discord. Usa o WebView2
do Windows em vez de embutir um Chromium inteiro. O lado nativo traz:

- **Bandeja:** fechar a janela só esconde; o Concord segue na call e recebendo menções. Clique no ícone para voltar.
- **Notificações do sistema** quando alguém te menciona e você não está olhando o canal (no navegador, ative em
  menu do usuário → "Ativar notificações de menção").
- **Push-to-talk global** (padrão F8): funciona com o jogo em foco. Ligue em "Push-to-talk" no painel de voz. No
  navegador o mesmo botão funciona, mas só com a aba em foco.
- Links externos (anexos, sites) abrem no navegador do sistema; a página só ganha acesso às APIs nativas na origem
  configurada.

```bash
npm --prefix desktop install
```

```bash
npm --prefix desktop run dev
```

O endereço vem de `CONCORD_URL` (padrão http://localhost:5173) e a tecla de `CONCORD_PTT_KEY`; ou de um
`config.json` com `{"url": "...", "ptt_key": "F8"}` em `%APPDATA%\dev.concord.desktop\`. O instalador sai com
`npm --prefix desktop run build` (precisa de Rust e das Build Tools do Visual Studio).

## Protocolo do gateway

Envelope `{op, t, s, d}`, como no Discord. Opcodes: 0 DISPATCH, 1 HEARTBEAT, 2 IDENTIFY, 3 PRESENCE,
4 VOICE_STATE_UPDATE, 6 RESUME,
7 RECONNECT, 9 INVALID_SESSION, 10 HELLO, 11 HEARTBEAT_ACK. Eventos: `READY`, `RESUMED`, `GUILD_CREATE`,
`GUILD_MEMBER_ADD`, `CHANNEL_CREATE`, `MESSAGE_CREATE/UPDATE/DELETE`, `MESSAGE_ACK`, `TYPING_START`, `PRESENCE_UPDATE`, `VOICE_STATE_UPDATE`, `VOICE_SERVER_UPDATE`.

O fan-out hoje é um mapa em memória (`guild → sessões`) em [server/internal/gateway](server/internal/gateway/gateway.go).
Para várias instâncias, troca-se por pub/sub do Redis sem mexer na API.

## Próximos passos

- Fase 3 (resto): supressão de ruído mais forte com RNNoise
- Fase 4 (resto): apagar os arquivos do armazenamento quando a mensagem é apagada, e limpar envios autorizados que
  nunca entraram numa mensagem
- Fase 5: Prometheus/Grafana, k6, protocolo binário
