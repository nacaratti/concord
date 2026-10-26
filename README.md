# Concord

Plataforma de comunicação para um grupo pequeno de amigos: texto em tempo real hoje, voz e tela nas próximas fases.
Segue o plano em [Concord — Plano do Projeto](https://claude.ai/artifact/HccwfR8DZjjkgVYx1212Ay) e reproduz, em escala
menor, os três planos do Discord: **consultas** (REST), **tempo real** (gateway WebSocket) e **mídia** (WebRTC, Fase 3).

```
server/   Go: API REST + gateway WebSocket (net/http, coder/websocket, pgx)
web/      React + TypeScript + Vite, Zustand para estado
infra/    Docker Compose: PostgreSQL 17 e Redis
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

Variáveis do servidor: `DATABASE_URL`, `CONCORD_ADDR` (padrão `:8080`), `CONCORD_ORIGINS` (origens aceitas no
WebSocket, padrão `localhost:*,127.0.0.1:*`) e `CONCORD_WEB_DIR` (pasta do build do `web/` para servir tudo de um só
processo).

## O que já funciona (Fases 0 e 1, parte da 2)

- Cadastro e login com senha argon2id; token de sessão aleatório guardado só como hash SHA-256
- Snowflake IDs de 64 bits (serializados como string no JSON)
- Servidores, canais de texto/voz, convites por link (`/invite/<código>`, expiram em 7 dias)
- Gateway com HELLO, IDENTIFY, READY (snapshot completo do estado), heartbeat e detecção de conexão zumbi
- **RESUME**: a sessão sobrevive 2 minutos a uma queda; o servidor reenvia os eventos perdidos pelo número de sequência
- Reconexão com backoff exponencial + jitter no cliente
- Mensagens via REST com entrega via gateway (`MESSAGE_CREATE`), **envio otimista com `nonce`**, falha com "tentar de novo"
- Histórico paginado por cursor (`before=<id>`), carregado ao rolar para cima
- Edição, exclusão, @menções com destaque, canais não lidos
- Indicador de digitação e presença (online, ausente, não perturbar, "Jogando X")
- Checagem de pertencimento em toda rota e em toda inscrição de tópico do gateway

O menu do usuário (canto inferior esquerdo) tem **Simular queda de conexão**, para ver o RESUME acontecendo no DevTools.

## Protocolo do gateway

Envelope `{op, t, s, d}`, como no Discord. Opcodes: 0 DISPATCH, 1 HEARTBEAT, 2 IDENTIFY, 3 PRESENCE, 6 RESUME,
7 RECONNECT, 9 INVALID_SESSION, 10 HELLO, 11 HEARTBEAT_ACK. Eventos: `READY`, `RESUMED`, `GUILD_CREATE`,
`GUILD_MEMBER_ADD`, `CHANNEL_CREATE`, `MESSAGE_CREATE/UPDATE/DELETE`, `TYPING_START`, `PRESENCE_UPDATE`.

O fan-out hoje é um mapa em memória (`guild → sessões`) em [server/internal/gateway](server/internal/gateway/gateway.go).
Para várias instâncias, troca-se por pub/sub do Redis sem mexer na API.

## Próximos passos

- Fase 2: rate limit (token bucket no Redis), contagem persistente de não lidas (`read_states`)
- Fase 3: LiveKit no Compose, tokens emitidos pelo backend, `VOICE_STATE_UPDATE`
- Fase 4: tela, uploads via MinIO, app Tauri
- Fase 5: Prometheus/Grafana, k6, protocolo binário
