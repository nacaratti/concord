// Conexão de mídia com o LiveKit (SFU). O gateway decide QUEM está em qual call;
// aqui só se transporta áudio e tela, direto entre o navegador e o LiveKit.
// Só tipos aqui: a biblioteca (~540 kB) é carregada sob demanda na primeira vez que alguém entra numa call.
import type {
  ConnectionQuality,
  Participant,
  RemoteParticipant,
  RemoteTrackPublication,
  Room,
  TrackPublication,
} from 'livekit-client'

type LiveKit = typeof import('livekit-client')

export type VoiceStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting'

export interface VoiceCallbacks {
  onStatus: (status: VoiceStatus) => void
  /** Ids de usuário de quem está falando agora (inclui você). */
  onSpeaking: (userIds: string[]) => void
  onQuality: (quality: 'excellent' | 'good' | 'poor' | 'lost' | 'unknown') => void
  onMicError: (message: string | null) => void
  /** Ids de usuário de quem está compartilhando a tela nesta call (inclui você). */
  onScreens: (userIds: string[]) => void
  /** O meu compartilhamento começou ou terminou (inclusive pelo botão "Parar" do navegador). */
  onSharing: (sharing: boolean) => void
}

/** A identidade no LiveKit é "<userId>:<sessionId>" (ver server/internal/voice). */
export function userIdOf(identity: string): string {
  return identity.split(':')[0]
}

// Captura pensada para jogo: o navegador já faz supressão de ruído, cancelamento de eco e ganho automático.
const capture = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

export class VoiceClient {
  private cb: VoiceCallbacks
  private lk: LiveKit | null = null
  private room: Room | null = null
  private deafened = false
  private volumes: Record<string, number> = {}
  private speakingTimer: number | undefined
  private lastHeard = new Map<string, number>()
  private meterCtx: AudioContext | null = null
  private meters = new Map<
    string,
    { userId: string; source: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer> }
  >()
  private lastSpeakingKey = ''
  /** Telas que estou assistindo: usuário → elemento <video>. */
  private watching = new Map<string, HTMLVideoElement>()

  constructor(cb: VoiceCallbacks) {
    this.cb = cb
  }

  async connect(endpoint: string, token: string, muted: boolean, deafened: boolean, volumes: Record<string, number>) {
    await this.disconnect()
    const lk = (this.lk ??= await import('livekit-client'))
    const { Room, RoomEvent, Track } = lk
    this.deafened = deafened
    this.volumes = { ...volumes }
    // webAudioMix permite volume acima de 100% por pessoa; adaptiveStream escolhe a camada do simulcast
    // pelo tamanho do <video> em que a tela é exibida.
    const room = new Room({ adaptiveStream: true, dynacast: true, webAudioMix: true })
    this.room = room

    room
      .on(RoomEvent.TrackPublished, (pub, participant) => this.onRemotePublished(pub, participant))
      .on(RoomEvent.TrackUnpublished, () => this.emitScreens())
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        const userId = userIdOf(participant.identity)
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach()
          el.dataset.concordVoice = participant.identity
          el.dataset.concordTrack = pub.trackSid
          document.body.appendChild(el)
          this.applyVolume(participant)
          // Só o microfone conta para "quem está falando"; o áudio do jogo, não.
          if (pub.source === Track.Source.Microphone) this.addMeter(pub.trackSid, userId, track.mediaStreamTrack)
        } else if (pub.source === Track.Source.ScreenShare) {
          const el = this.watching.get(userId)
          if (el) track.attach(el)
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track, pub) => {
        track.detach()
        // Remove pelo id da faixa: com webAudioMix o detach() nem sempre devolve o <audio> que criamos.
        document.querySelectorAll(`audio[data-concord-track="${pub.trackSid}"]`).forEach((el) => el.remove())
        this.removeMeter(pub.trackSid)
      })
      .on(RoomEvent.ParticipantDisconnected, () => this.emitScreens())
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        // O meu microfone também passa pelo medidor, para o anel aparecer em mim do mesmo jeito.
        if (pub.source === Track.Source.Microphone && pub.track) {
          this.addMeter(pub.trackSid, userIdOf(room.localParticipant.identity), pub.track.mediaStreamTrack)
        }
        if (pub.source === Track.Source.ScreenShare) {
          this.cb.onSharing(true)
          this.emitScreens()
        }
      })
      .on(RoomEvent.LocalTrackUnpublished, (pub) => {
        this.removeMeter(pub.trackSid)
        if (pub.source === Track.Source.ScreenShare) {
          this.cb.onSharing(false)
          this.emitScreens()
        }
      })
      .on(RoomEvent.ConnectionQualityChanged, (q: ConnectionQuality, p: Participant) => {
        if (p.isLocal) this.cb.onQuality(q as 'excellent' | 'good' | 'poor' | 'lost' | 'unknown')
      })
      .on(RoomEvent.Reconnecting, () => this.room === room && this.cb.onStatus('reconnecting'))
      .on(RoomEvent.Reconnected, () => this.room === room && this.cb.onStatus('connected'))
      .on(RoomEvent.Disconnected, () => {
        if (this.room !== room) return
        this.room = null
        this.cb.onSpeaking([])
        this.cb.onScreens([])
        this.cb.onSharing(false)
        this.cb.onStatus('idle')
      })

    this.cb.onStatus('connecting')
    // Sem inscrição automática: o microfone de todos é assinado sempre, mas a tela (vídeo + áudio do jogo)
    // só quando você clica para assistir, como no Discord. Economiza banda de quem não está olhando.
    await room.connect(endpoint, token, { autoSubscribe: false })
    if (this.room !== room) return // saiu enquanto conectava
    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) this.onRemotePublished(pub, p)
    }
    this.cb.onStatus('connected')
    this.speakingTimer = window.setInterval(() => this.pollSpeaking(), 150)
    if (!muted) await this.setMuted(false)
  }

  private onRemotePublished(pub: RemoteTrackPublication, participant: RemoteParticipant) {
    const { Track } = this.lk!
    if (pub.source === Track.Source.Microphone) pub.setSubscribed(true)
    const watching = this.watching.has(userIdOf(participant.identity))
    if (pub.source === Track.Source.ScreenShare || pub.source === Track.Source.ScreenShareAudio) {
      if (watching) pub.setSubscribed(true)
      this.emitScreens()
    }
  }

  private emitScreens() {
    const room = this.room
    if (!room || !this.lk) return this.cb.onScreens([])
    const { Track } = this.lk
    const ids = new Set<string>()
    for (const p of room.remoteParticipants.values()) {
      if (p.getTrackPublication(Track.Source.ScreenShare)) ids.add(userIdOf(p.identity))
    }
    if (room.localParticipant.getTrackPublication(Track.Source.ScreenShare)) {
      ids.add(userIdOf(room.localParticipant.identity))
    }
    this.cb.onScreens([...ids])
  }

  /**
   * Passa a assistir a tela de `userId` no elemento `el` (assina vídeo + áudio do jogo).
   * Devolve a função que para de assistir e cancela a assinatura.
   */
  watch(userId: string, el: HTMLVideoElement): () => void {
    const room = this.room
    if (!room || !this.lk) return () => {}
    const { Track } = this.lk
    this.watching.set(userId, el)
    const pubs: TrackPublication[] = []
    if (userIdOf(room.localParticipant.identity) === userId) {
      // A minha própria tela: prévia local, sem passar pelo servidor.
      const pub = room.localParticipant.getTrackPublication(Track.Source.ScreenShare)
      pub?.track?.attach(el)
      if (pub) pubs.push(pub)
    } else {
      for (const p of room.remoteParticipants.values()) {
        if (userIdOf(p.identity) !== userId) continue
        for (const source of [Track.Source.ScreenShare, Track.Source.ScreenShareAudio]) {
          const pub = p.getTrackPublication(source)
          if (!pub) continue
          pub.setSubscribed(true)
          if (pub.track && source === Track.Source.ScreenShare) pub.track.attach(el) // já estava assinada
          pubs.push(pub)
        }
      }
    }
    return () => {
      if (this.watching.get(userId) === el) this.watching.delete(userId)
      for (const pub of pubs) {
        pub.track?.detach(el)
        if ('setSubscribed' in pub) (pub as RemoteTrackPublication).setSubscribed(false)
      }
    }
  }

  /** Liga ou desliga o compartilhamento de tela, com o áudio do sistema quando o navegador oferece. */
  async setSharing(on: boolean): Promise<string | null> {
    const room = this.room
    if (!room || !this.lk) return 'Entre numa call para compartilhar a tela'
    const { ScreenSharePresets } = this.lk
    try {
      await room.localParticipant.setScreenShareEnabled(
        on,
        {
          audio: true, // áudio do jogo (no Chrome/Edge: marque "Compartilhar áudio" na janela de escolha)
          systemAudio: 'include',
          selfBrowserSurface: 'exclude',
          contentHint: 'motion', // prioriza fluidez sobre nitidez: é jogo, não planilha
          resolution: ScreenSharePresets.h1080fps30.resolution,
        },
        {
          screenShareEncoding: ScreenSharePresets.h1080fps30.encoding,
          // Simulcast: quem tem internet pior (ou assiste numa janela pequena) recebe 360p ou 720p.
          screenShareSimulcastLayers: [ScreenSharePresets.h360fps15, ScreenSharePresets.h720fps30],
        },
      )
      return null
    } catch (err) {
      if ((err as Error).name === 'NotAllowedError') return null // cancelou a janela de escolha
      return 'Não foi possível compartilhar a tela'
    }
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
    this.watching.clear()
    if (room) await room.disconnect()
    document.querySelectorAll('[data-concord-voice]').forEach((el) => el.remove())
    this.cb.onSpeaking([])
    this.cb.onScreens([])
  }

  async setMuted(muted: boolean) {
    if (!this.room || !this.lk) return
    const { AudioPresets } = this.lk
    try {
      // Opus em perfil de voz, com DTX (não transmite no silêncio) e RED (redundância contra perda de pacotes).
      await this.room.localParticipant.setMicrophoneEnabled(!muted, capture, {
        audioPreset: AudioPresets.speech,
        dtx: true,
        red: true,
      })
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

  /** Volume por pessoa: 0 a 2 (0% a 200%). Vale para a voz e para o áudio da tela dela. */
  setUserVolume(userId: string, volume: number) {
    this.volumes[userId] = volume
    this.room?.remoteParticipants.forEach((p) => userIdOf(p.identity) === userId && this.applyVolume(p))
  }

  private applyVolume(p: RemoteParticipant) {
    const v = this.deafened ? 0 : (this.volumes[userIdOf(p.identity)] ?? 1)
    p.setVolume(v)
    if (this.lk) p.setVolume(v, this.lk.Track.Source.ScreenShareAudio)
  }
}
