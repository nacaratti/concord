// Cliente do gateway: HELLO → IDENTIFY/RESUME → READY, heartbeat com detecção de conexão zumbi
// e reconexão com backoff exponencial + jitter.

export const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Presence: 3,
  VoiceStateUpdate: 4,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
} as const

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

interface Frame {
  op: number
  t?: string
  s?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  d: any
}

export interface GatewayOptions {
  token: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onDispatch: (t: string, d: any) => void
  onState: (state: ConnectionState) => void
  onAuthFailed: () => void
}

export class Gateway {
  private opts: GatewayOptions
  private ws: WebSocket | null = null
  private seq = 0
  private sessionId: string | null = null
  private heartbeatTimer: number | undefined
  private reconnectTimer: number | undefined
  private acked = true
  private attempts = 0
  private stopped = false

  constructor(opts: GatewayOptions) {
    this.opts = opts
  }

  connect() {
    this.stopped = false
    this.opts.onState(this.sessionId ? 'reconnecting' : 'connecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/gateway`)
    this.ws = ws
    ws.onmessage = (ev) => this.handle(JSON.parse(ev.data) as Frame)
    ws.onclose = (ev) => {
      if (this.ws !== ws) return
      this.ws = null
      window.clearInterval(this.heartbeatTimer)
      if (this.stopped) return
      if (ev.code === 4004) {
        this.opts.onState('disconnected')
        this.opts.onAuthFailed()
        return
      }
      this.scheduleReconnect()
    }
  }

  close() {
    this.stopped = true
    window.clearInterval(this.heartbeatTimer)
    window.clearTimeout(this.reconnectTimer)
    this.ws?.close(1000)
    this.ws = null
    this.opts.onState('disconnected')
  }

  updatePresence(status: string, activity: string) {
    this.send({ op: Op.Presence, d: { status, activity } })
  }

  /** Entra, troca, sai (channelId null) ou só muda mute/deafen numa call. */
  updateVoiceState(guildId: string, channelId: string | null, selfMute: boolean, selfDeaf: boolean, selfStream = false) {
    this.send({
      op: Op.VoiceStateUpdate,
      d: { guild_id: guildId, channel_id: channelId, self_mute: selfMute, self_deaf: selfDeaf, self_stream: selfStream },
    })
  }

  get session(): string | null {
    return this.sessionId
  }

  /** Só para depuração: derruba o socket para ver o RESUME acontecer. */
  simulateDrop() {
    this.ws?.close(4000, 'queda simulada')
  }

  private send(f: Frame) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f))
  }

  private scheduleReconnect() {
    this.opts.onState('reconnecting')
    // 1s, 2s, 4s... até 30s, multiplicado por um fator aleatório para não reconectar todo mundo junto.
    const base = Math.min(30_000, 1000 * 2 ** this.attempts)
    const delay = base * (0.5 + Math.random())
    this.attempts++
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay)
  }

  private handle(f: Frame) {
    switch (f.op) {
      case Op.Hello: {
        this.startHeartbeat(f.d.heartbeat_interval)
        if (this.sessionId) {
          this.send({ op: Op.Resume, d: { token: this.opts.token, session_id: this.sessionId, seq: this.seq } })
        } else {
          this.identify()
        }
        break
      }
      case Op.Dispatch: {
        if (f.s) this.seq = f.s
        if (f.t === 'READY') this.sessionId = f.d.session_id
        if (f.t === 'READY' || f.t === 'RESUMED') {
          this.attempts = 0
          this.opts.onState('connected')
        }
        this.opts.onDispatch(f.t!, f.d)
        break
      }
      case Op.HeartbeatAck:
        this.acked = true
        break
      case Op.InvalidSession:
        // A sessão não pode ser retomada: começa do zero no mesmo socket.
        this.sessionId = null
        this.seq = 0
        this.identify()
        break
      case Op.Reconnect:
        this.ws?.close(4000, 'reconnect pedido pelo servidor')
        break
    }
  }

  private identify() {
    this.send({ op: Op.Identify, d: { token: this.opts.token } })
  }

  private startHeartbeat(interval: number) {
    window.clearInterval(this.heartbeatTimer)
    this.acked = true
    const beat = () => {
      if (!this.acked) {
        // Nenhum ACK desde o último heartbeat: conexão zumbi, reconecta.
        this.ws?.close(4000, 'sem heartbeat ack')
        return
      }
      this.acked = false
      this.send({ op: Op.Heartbeat, d: this.seq })
    }
    // O primeiro heartbeat sai num instante aleatório do intervalo, como no Discord.
    this.heartbeatTimer = window.setTimeout(() => {
      beat()
      this.heartbeatTimer = window.setInterval(beat, interval)
    }, interval * Math.random())
  }
}
