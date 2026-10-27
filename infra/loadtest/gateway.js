// Teste de carga do gateway (Fase 5): 1.000 conexões WebSocket abertas ao mesmo tempo num servidor,
// enquanto mensagens chegam a 5/s. Cada mensagem é entregue a todas as sessões, ou seja,
// 5.000 entregas por segundo, e cada conexão mede quanto a mensagem levou para chegar.
//
// O servidor precisa estar com CONCORD_RATELIMIT=off (senão o limite de conexões por IP barra o teste).
// Rodar (de dentro de infra/):
//   docker compose --profile loadtest run --rm k6 run /scripts/gateway.js
// Variáveis: VUS (padrão 1000), RATE (mensagens/s, padrão 5), COMPRESSION (deflate|off, padrão deflate),
// RAMP e HOLD (segundos, padrão 60 cada). Ensaio rápido: VUS=20 RAMP=5 HOLD=10
import http from 'k6/http'
import { WebSocket } from 'k6/websockets'
import { Counter, Trend } from 'k6/metrics'
import { check } from 'k6'

const BASE = __ENV.BASE_URL || 'http://host.docker.internal:8080'
const WS = BASE.replace(/^http/, 'ws') + '/gateway'
const VUS = Number(__ENV.VUS || 1000)
const RATE = Number(__ENV.RATE || 5)
const COMPRESSION = (__ENV.COMPRESSION || 'deflate') === 'deflate'
const RAMP = Number(__ENV.RAMP || 60) // segundos subindo conexões
const HOLD = Number(__ENV.HOLD || 60) // segundos com todas abertas e mensagens chegando
const USERS = 50 // as 1.000 conexões se dividem entre 50 contas (várias abas por pessoa)

const delivery = new Trend('message_delivery', true) // do POST no remetente até chegar em cada conexão
const readyTime = new Trend('gateway_ready', true) // de abrir o socket até o READY
const delivered = new Counter('messages_delivered')
const sent = new Counter('messages_sent')

export const options = {
  setupTimeout: '120s',
  scenarios: {
    conexoes: {
      executor: 'ramping-vus',
      exec: 'listener',
      startVUs: 0,
      stages: [
        { duration: `${RAMP}s`, target: VUS }, // sobe as conexões aos poucos
        { duration: `${HOLD}s`, target: VUS }, // segura todas abertas
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '5s',
    },
    mensagens: {
      executor: 'constant-arrival-rate',
      exec: 'chatter',
      rate: RATE,
      timeUnit: '1s',
      startTime: `${RAMP}s`, // só depois que todas as conexões estão de pé
      duration: `${HOLD}s`,
      preAllocatedVUs: 10,
    },
  },
  thresholds: {
    message_delivery: ['p(95)<100'], // meta do plano: entregar em menos de 100 ms
    gateway_ready: ['p(95)<1000'],
    checks: ['rate>0.99'],
  },
}

const auth = (token) => ({ headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token } })

// Cria as contas, um servidor e põe todo mundo nele.
export function setup() {
  const run = Date.now().toString(36)
  const tokens = []
  for (let i = 0; i < USERS; i++) {
    const r = http.post(`${BASE}/api/auth/register`, JSON.stringify({ username: `carga_${run}_${i}`, password: 'senha-de-carga-123' }), {
      headers: { 'Content-Type': 'application/json' },
    })
    if (r.status !== 201) throw new Error(`cadastro falhou (${r.status}): o servidor está com CONCORD_RATELIMIT=off?`)
    tokens.push(r.json('token'))
  }
  const guild = http.post(`${BASE}/api/guilds`, JSON.stringify({ name: 'Teste de carga' }), auth(tokens[0]))
  const guildId = guild.json('id')
  const channelId = guild.json('channels').find((c) => c.kind === 0).id
  const invite = http.post(`${BASE}/api/guilds/${guildId}/invites`, '{}', auth(tokens[0])).json('code')
  for (const t of tokens.slice(1)) http.post(`${BASE}/api/invites/${invite}`, null, auth(t))
  return { tokens, channelId }
}

// Uma conexão do gateway: HELLO → IDENTIFY → READY, heartbeat, e mede cada MESSAGE_CREATE.
export function listener(data) {
  const token = data.tokens[__VU % USERS]
  const opened = Date.now()
  // Atenção: o k6 só oferece permessage-deflate SEM contexto; aí o servidor só comprime frames acima de
  // 512 bytes, ou seja, quase nenhum evento. Para medir a compressão como no navegador, use compression.mjs.
  const params = { headers: { Origin: 'http://localhost:5173' } }
  if (COMPRESSION) params.compression = 'deflate'
  const ws = new WebSocket(WS, null, params)
  let seq = null
  let beat
  ws.onmessage = (e) => {
    const f = JSON.parse(e.data)
    if (f.s) seq = f.s
    if (f.op === 10) {
      ws.send(JSON.stringify({ op: 2, d: { token } }))
      beat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), f.d.heartbeat_interval)
    } else if (f.t === 'READY') {
      readyTime.add(Date.now() - opened)
      check(f, { 'READY recebido': () => true })
    } else if (f.t === 'MESSAGE_CREATE' && f.d.content.startsWith('carga:')) {
      delivery.add(Date.now() - Number(f.d.content.slice(6)))
      delivered.add(1)
    }
  }
  ws.onerror = () => check(null, { 'websocket sem erro': () => false })
  ws.onclose = () => clearInterval(beat)
  // A conexão fica aberta até o fim do estágio; o k6 encerra o VU no ramp-down.
  setTimeout(() => ws.close(), (RAMP + HOLD + 5) * 1000)
}

// Remetentes: postam mensagens com a hora do envio no texto.
export function chatter(data) {
  const token = data.tokens[Math.floor(Math.random() * USERS)]
  const r = http.post(`${BASE}/api/channels/${data.channelId}/messages`, JSON.stringify({ content: `carga:${Date.now()}` }), auth(token))
  check(r, { 'mensagem aceita': (x) => x.status === 200 })
  sent.add(1)
}
