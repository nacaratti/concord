// Conexão de mídia com o LiveKit (SFU). O gateway decide QUEM está em qual call;
// aqui só se transporta o áudio, direto entre o navegador e o LiveKit.
// Só tipos aqui: a biblioteca (~540 kB) é carregada sob demanda na primeira vez que alguém entra numa call.
import type { ConnectionQuality, Participant, RemoteParticipant, Room } from 'livekit-client'

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting'

export interface VoiceCallbacks {
  onStatus: (status: VoiceStatus) => void
  /** Ids de usuário de quem está falando agora (inclui você). */
  onSpeaking: (userIds: string[]) => void
  onQuality: (quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown') => void
  onMicError: (message: string | null) => void
}

/** A identidade no LiveKit é "<userId>:<sessionId>" (ver server/internal/voice). */
export function userIdOf(identity: string): string {
  return identity.split(':')[0]
}

// Captura pensada para jogo: o navegador já faz supressão de ruído, cancelamento de eco e ganho automático.
const capture = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

export class VoiceClient {
  private cb: VoiceCallbacks
  private room: Room | null = null
  private deafened = false
  private volumes: Record<string, number> = {}
  private publish = {}
  private speakingTimer: number | undefined
  private lastHeard = new Map<string, number>()
  private meterCtx: AudioContext | null = null
  private meters = new Map<
    string,
    { userId: string; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> }
  >()
  private lastSpeakingKey = ''

  constructor(cb: VoiceCallbacks) {
    this.cb = cb
  }

  async connect(endpoint: string, token: string, muted: boolean, deafened: boolean, volumes: Record<string, number>) {
    await this.disconnect()
    const { AudioPresets, Room, RoomEvent, Track } = await import('livekit-client')
    // Opus em perfil de voz, com DTX (não transmite no silêncio) e RED (redundância contra perda de pacotes).
    this.publish = { audioPreset: AudioPresets.speech, dtx: true, red: true }
    this.deafened = deafened
    this.volumes = { ...volumes }
    // webAudioMix permite volume acima de 100% por pessoa.
    const room = new Room({ adaptiveStream: true, dynacast: true, webAudioMix: true })
    this.room = room

    room
      .on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
        if (track.kind !== Track.Kind.Audio) return
        const el = track.attach()
        el.dataset.concordVoice = participant.identity
        document.body.appendChild(el)
        this.applyVolume(participant)
        this.addMeter(track.sid ?? participant.identity, userIdOf(participant.identity), track.mediaStreamTrack)
      })
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
        track.detach().forEach((el) => el.remove())
        this.removeMeter(track.sid ?? participant.identity)
      })
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        // O meu microfone também passa pelo medidor, para o anel aparecer em mim do mesmo jeito.
        if (pub.track?.kind === Track.Kind.Audio) {
          this.addMeter(pub.trackSid, userIdOf(room.localParticipant.identity), pub.track.mediaStreamTrack)
        }
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => this.removeMeter(pub.trackSid))
      .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
        if (p.isLocal) this.cb.onQuality(q as 'excellent' | 'good' | 'poor' | 'lost' | 'unknown')
      })
      .on(RoomEvent.Reconnecting, () => this.room === room && this.cb.onStatus('reconnecting'))
      .on(RoomEvent.Reconnected, () => this.room === room && this.cb.onStatus('connected'))
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room) return
        this.room = null
        this.cb.onSpeaking([])
        this.cb.onStatus('idle')
      })

    this.cb.onStatus('connecting')
    await room.connect(endpoint, token)
    if (this.room !== room) return // saiu enquanto conectava
    this.cb.onStatus('connected')
    this.speakingTimer = window.setInterval(() => this.pollSpeaking(), 150)
    if (!muted) await this.setMuted(false)
  }

  /**
   * Quem está falando, medido aqui mesmo com um AnalyserNode sobre o áudio que já é decodificado para tocar.
   * O evento ActiveSpeakersChanged do LiveKit só avisa mudanças, então quem entra numa call em que alguém
   * já fala não veria o indicador. (O nível RFC 6464 do RTP seria mais barato, mas o LiveKit não o repassa.)
   */
  private pollSpeaking() {
    const now = performance.now()
    for (const m of this.meters.values()) {
      m.analyser.getFloatTimeDomainData(m.buf)
      let sum = 0
      for (const v of m.buf) sum += v * v
      // RMS acima de 0,01 (≈ -40 dBFS) conta como fala.
      if (Math.sqrt(sum / m.buf.length) > 0.01) this.lastHeard.set(m.userId, now)
    }
    this.emitSpeaking()
  }

  private addMeter(trackSid: string, userId: string, track: MediaStreamTrack) {
    this.meterCtx ??= new AudioContext()
    void this.meterCtx.resume()
    const source = this.meterCtx.createMediaStreamSource(new MediaStream([track]))
    const analyser = this.meterCtx.createAnalyser()
    analyser.fftSize = 512
    source.connect(analyser) // não vai para a saída: só mede, quem toca é o <audio>
    this.meters.set(trackSid, { userId, source, analyser, buf: new Float32Array(analyser.fftSize) })
  }

  private removeMeter(trackSid: string) {
    this.meters.get(trackSid)?.source.disconnect()
    this.meters.delete(trackSid)
  }

  private emitSpeaking() {
    const now = performance.now()
    // 400 ms de "rabo" para o anel não piscar entre uma sílaba e outra.
    const ids = [...this.lastHeard].filter(([, t]) => now - t < 400).map(([id]) => id)
    const key = ids.sort().join(',')
    if (key !== this.lastSpeakingKey) {
      this.lastSpeakingKey = key
      this.cb.onSpeaking(ids)
    }
  }

  async disconnect() {
    const room = this.room
    this.room = null
    window.clearInterval(this.speakingTimer)
    for (const sid of [...this.meters.keys()]) this.removeMeter(sid)
    this.lastHeard.clear()
    this.lastSpeakingKey = ''
    if (room) await room.disconnect()
    document.querySelectorAll('[data-concord-voice]').forEach((el) => el.remove())
    this.cb.onSpeaking([])
  }

  async setMuted(muted: boolean) {
    if (!this.room) return
    try {
      await this.room.localParticipant.setMicrophoneEnabled(!muted, capture, this.publish)
      this.cb.onMicError(null)
    } catch (err) {
      // Sem microfone ou permissão negada: continua na call só ouvindo.
      this.cb.onMicError((err as Error).name === 'NotAllowedError' ? 'Permissão do microfone negada' : 'Microfone indisponível')
    }
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened
    this.room?.remoteParticipants.forEach((p) => this.applyVolume(p))
  }

  /** Volume por pessoa: 0 a 2 (0% a 200%). */
  setUserVolume(userId: string, volume: number) {
    this.volumes[userId] = volume
    this.room?.remoteParticipants.forEach((p) => userIdOf(p.identity) === userId && this.applyVolume(p))
  }

  private applyVolume(p: RemoteParticipant) {
    p.setVolume(this.deafened ? 0 : (this.volumes[userIdOf(p.identity)] ?? 1))
  }
}
