// Mede o custo e o ganho do permessage-deflate COM contexto, o modo que os navegadores negociam
// (o k6 só faz o modo sem contexto). Abre N conexões, faz mensagens chegarem e reporta:
//   - bytes reais lidos do socket por entrega (banda no fio)
//   - memória do servidor (heap e memória pedida ao sistema) antes e no pico
//
// O servidor precisa estar com CONCORD_RATELIMIT=off.
//   npm --prefix infra/loadtest install
//   node infra/loadtest/compression.mjs --compress   (ou --no-compress)
// Opções: --conns 1000 --rate 5 --secs 30 --base http://localhost:8080 --metrics http://localhost:9091/metrics
import WebSocket from 'ws'

const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 ? process.argv[i + 1] : def
}
const COMPRESS = !process.argv.includes('--no-compress')
const CONNS = Number(arg('conns', 1000))
const RATE = Number(arg('rate', 5))
const SECS = Number(arg('secs', 30))
const BASE = arg('base', 'http://localhost:8080')
const METRICS = arg('metrics', 'http://localhost:9091/metrics')
const USERS = 50
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(method, path, body, token) {
  const r = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${await r.text()} (o servidor está com CONCORD_RATELIMIT=off?)`)
  return r.status === 204 ? null : r.json()
}

async function memory() {
  const text = await (await fetch(METRICS)).text()
  const get = (name) => Number(text.match(new RegExp(`^${name} (\\S+)`, 'm'))?.[1] ?? NaN)
  return { heap: get('go_memstats_heap_inuse_bytes'), sys: get('go_memstats_sys_bytes') }
}
const mb = (b) => (b / 1024 / 1024).toFixed(0) + ' MB'

// Contas, um servidor e todo mundo dentro.
const run = Date.now().toString(36)
const tokens = []
for (let i = 0; i < USERS; i++) tokens.push((await api('POST', '/auth/register', { username: `comp_${run}_${i}`, password: 'senha-de-carga-123' })).token)
const guild = await api('POST', '/guilds', { name: 'Compressão' }, tokens[0])
const channel = guild.channels.find((c) => c.kind === 0).id
const invite = await api('POST', `/guilds/${guild.id}/invites`, {}, tokens[0])
for (const t of tokens.slice(1)) await api('POST', `/invites/${invite.code}`, null, t)

global.gc?.()
await sleep(2000)
const before = await memory()

// Conexões. perMessageDeflate do `ws` negocia COM contexto (como Chrome e Firefox).
const sockets = []
let ready = 0
let delivered = 0
let negotiated = 0
const latencies = []
const wsUrl = BASE.replace(/^http/, 'ws') + '/gateway'
for (let i = 0; i < CONNS; i++) {
  const ws = new WebSocket(wsUrl, { origin: 'http://localhost:5173', perMessageDeflate: COMPRESS })
  ws.on('upgrade', (res) => {
    if (/permessage-deflate/.test(res.headers['sec-websocket-extensions'] ?? '') && !/server_no_context_takeover/.test(res.headers['sec-websocket-extensions'])) negotiated++
  })
  ws.on('message', (raw) => {
    const f = JSON.parse(raw)
    if (f.op === 10) {
      ws.send(JSON.stringify({ op: 2, d: { token: tokens[i % USERS] } }))
      ws.beat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: null })), f.d.heartbeat_interval)
    } else if (f.t === 'READY') ready++
    else if (f.t === 'MESSAGE_CREATE') {
      delivered++
      const sentAt = Number(f.d.content.split('@')[1])
      if (sentAt) latencies.push(Date.now() - sentAt)
    }
  })
  ws.on('error', () => {})
  sockets.push(ws)
  if (i % 50 === 49) await sleep(100) // sobe em lotes, como num reinício do servidor
}
while (ready < CONNS) await sleep(200)
await sleep(1000)
const connected = await memory()
const wireAtStart = sockets.reduce((n, ws) => n + (ws._socket?.bytesRead ?? 0), 0)
const deliveredAtStart = delivered
latencies.length = 0

// Mensagens chegando a RATE/s por SECS segundos; a memória é amostrada a cada segundo.
let peak = connected
const sampler = setInterval(async () => {
  const m = await memory()
  if (m.heap > peak.heap) peak = m
}, 1000)
for (let i = 0; i < RATE * SECS; i++) {
  void api('POST', `/channels/${channel}/messages`, { content: `teste de compressão ${i}: bora jogar uma ranked depois do almoço? @${Date.now()}` }, tokens[i % USERS])
  await sleep(1000 / RATE)
}
await sleep(2000)
clearInterval(sampler)

const wire = sockets.reduce((n, ws) => n + (ws._socket?.bytesRead ?? 0), 0) - wireAtStart
const n = delivered - deliveredAtStart
latencies.sort((a, b) => a - b)
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))]
console.log(JSON.stringify({
  modo: COMPRESS ? 'permessage-deflate com contexto' : 'sem compressão',
  conexoes: CONNS,
  compressao_negociada_com_contexto: negotiated,
  entregas: n,
  bytes_no_fio_por_entrega: Math.round(wire / n),
  entrega_ms: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: latencies.at(-1) },
  memoria: {
    antes: { heap: mb(before.heap), sys: mb(before.sys) },
    com_conexoes: { heap: mb(connected.heap), sys: mb(connected.sys) },
    pico: { heap: mb(peak.heap), sys: mb(peak.sys) },
    heap_por_conexao_kb: Math.round((peak.heap - before.heap) / CONNS / 1024),
  },
}, null, 2))
for (const ws of sockets) {
  clearInterval(ws.beat)
  ws.terminate()
}
process.exit(0)
