import { useEffect, useRef, useState } from 'react'
import { isDesktop, pttKey, useStore } from '../store'
import type { Channel, Guild } from '../types'
import { Avatar } from './Avatar'
import { Icon } from './Icon'

/** Canal de voz na barra lateral, com quem está nele logo abaixo. */
export function VoiceChannel({ guild, channel }: { guild: Guild; channel: Channel }) {
  const { voiceStates, voice, joinVoice, me } = useStore()
  const inCall = Object.values(voiceStates).filter((vs) => vs.channel_id === channel.id)
  const mine = voice.channelId === channel.id
  return (
    <div>
      <button
        className={`channel voice ${mine ? 'active' : ''}`}
        onClick={() => joinVoice(guild.id, channel.id)}
        title={mine ? 'Você está aqui' : 'Entrar na call'}
      >
        <span className="hash">
          <Icon name="speaker" size={18} />
        </span>
        <span className="ellipsis">{channel.name}</span>
      </button>
      {inCall.map((vs) => {
        const member = guild.members.find((m) => m.user.id === vs.user_id)
        if (!member) return null
        // Só sei quem está falando se estou na mesma call (o áudio passa por mim).
        const speaking = mine && voice.speaking.includes(vs.user_id)
        return (
          <VoiceParticipant
            key={vs.user_id}
            userId={vs.user_id}
            name={member.nickname ?? member.user.display_name}
            avatar={<Avatar user={member.user} size={24} />}
            speaking={speaking}
            muted={vs.self_mute}
            deafened={vs.self_deaf}
            streaming={vs.self_stream}
            canWatch={mine && voice.screens.includes(vs.user_id)}
            canAdjust={mine && vs.user_id !== me?.id}
          />
        )
      })}
    </div>
  )
}

function VoiceParticipant(props: {
  userId: string
  name: string
  avatar: React.ReactNode
  speaking: boolean
  muted: boolean
  deafened: boolean
  streaming: boolean
  canWatch: boolean
  canAdjust: boolean
}) {
  const watchStream = useStore((s) => s.watchStream)
  const volume = useStore((s) => s.userVolumes[props.userId] ?? 1)
  const setUserVolume = useStore((s) => s.setUserVolume)
  const [open, setOpen] = useState(false)
  return (
    <div className="voice-user-wrap">
      <button
        className={`voice-user ${props.speaking ? 'speaking' : ''}`}
        onClick={() => props.canAdjust && setOpen(!open)}
        title={props.canAdjust ? 'Ajustar volume' : undefined}
      >
        <span className="voice-avatar">{props.avatar}</span>
        <span className="ellipsis">{props.name}</span>
        <span className="voice-icons">
          {props.streaming && (
            <span
              className={`live-badge ${props.canWatch ? 'clickable' : ''}`}
              title={props.canWatch ? 'Assistir' : 'Entre na call para assistir'}
              onClick={(e) => {
                if (!props.canWatch) return
                e.stopPropagation()
                watchStream(props.userId)
              }}
            >
              AO VIVO
            </span>
          )}
          {props.deafened ? (
            <span title="Áudio desativado">
              <Icon name="headphones" size={14} slashed />
            </span>
          ) : props.muted ? (
            <span title="Microfone silenciado">
              <Icon name="mic" size={14} slashed />
            </span>
          ) : null}
          {volume !== 1 && <span className="muted small">{Math.round(volume * 100)}%</span>}
        </span>
      </button>
      {open && (
        <div className="volume-pop" onMouseLeave={() => setOpen(false)}>
          <label>
            Volume de {props.name}: {Math.round(volume * 100)}%
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={volume}
              onChange={(e) => setUserVolume(props.userId, Number(e.target.value))}
            />
          </label>
        </div>
      )}
    </div>
  )
}

const statusText: Record<string, string> = {
  connecting: 'Conectando…',
  connected: 'Voz conectada',
  reconnecting: 'Reconectando…',
  idle: 'Desconectado',
}

const qualityText: Record<string, string> = {
  excellent: 'excelente',
  good: 'boa',
  poor: 'ruim',
  lost: 'perdida',
}

/** Painel "Voz conectada" acima do usuário, como no Discord. */
export function VoicePanel() {
  const { voice, guilds, leaveVoice, toggleShare, togglePtt } = useStore()
  if (!voice.channelId || !voice.guildId) return null
  const g = guilds[voice.guildId]
  const ch = g?.channels.find((c) => c.id === voice.channelId)
  return (
    <div className="voice-panel">
      <div className="voice-panel-row">
        <div className="voice-panel-info">
          <span className={`voice-status ${voice.status}`}>{statusText[voice.status]}</span>
          <span className="ellipsis muted small">
            {ch?.name} / {g?.name}
            {voice.status === 'connected' && qualityText[voice.quality] && ` · conexão ${qualityText[voice.quality]}`}
          </span>
        </div>
        <button
          className={`icon-btn share ${voice.sharing ? 'on' : ''}`}
          title={voice.sharing ? 'Parar de compartilhar' : 'Compartilhar a tela'}
          disabled={voice.status !== 'connected'}
          onClick={() => void toggleShare()}
        >
          <Icon name="screen" />
        </button>
        <button className="icon-btn hangup" title="Desconectar" onClick={leaveVoice}>
          <Icon name="hangup" />
        </button>
      </div>
      <div className="voice-panel-row ptt-row">
        <button
          className={`ptt-toggle ${voice.pttMode ? 'on' : ''}`}
          onClick={togglePtt}
          title={isDesktop ? 'Funciona com o jogo em foco' : 'No navegador, só com esta aba em foco. Use o app desktop para jogar.'}
        >
          Push-to-talk ({pttKey}): {voice.pttMode ? 'ligado' : 'desligado'}
        </button>
        {voice.pttMode && <span className={`ptt-live ${voice.pttHeld ? 'on' : ''}`}>{voice.pttHeld ? 'transmitindo' : 'segure para falar'}</span>}
      </div>
      {voice.micError && <div className="error small">{voice.micError} — você está só ouvindo.</div>}
      {voice.shareError && <div className="error small">{voice.shareError}</div>}
    </div>
  )
}

/** Botões de microfone e fone, sempre visíveis no painel do usuário. */
export function VoiceControls() {
  const { voice, toggleMute, toggleDeaf } = useStore()
  return (
    <>
      <button
        className={`icon-btn ${voice.selfMute ? 'off' : ''}`}
        title={voice.selfMute ? 'Ativar microfone' : 'Silenciar microfone'}
        onClick={toggleMute}
      >
        <Icon name="mic" slashed={voice.selfMute} />
      </button>
      <button
        className={`icon-btn ${voice.selfDeaf ? 'off' : ''}`}
        title={voice.selfDeaf ? 'Ativar áudio' : 'Desativar áudio'}
        onClick={toggleDeaf}
      >
        <Icon name="headphones" slashed={voice.selfDeaf} />
      </button>
    </>
  )
}

/** Palco: a tela que estou assistindo, no lugar do chat. */
export function Stage({ userId }: { userId: string }) {
  const { attachStream, watchStream, guilds, voice, me } = useStore()
  const ref = useRef<HTMLVideoElement>(null)
  const [hasVideo, setHasVideo] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onData = () => setHasVideo(true)
    el.addEventListener('loadeddata', onData)
    const stop = attachStream(userId, el)
    return () => {
      el.removeEventListener('loadeddata', onData)
      stop()
    }
  }, [userId, attachStream])
  const name =
    userId === me?.id
      ? 'Sua tela'
      : (guilds[voice.guildId ?? '']?.members.find((m) => m.user.id === userId)?.user.display_name ?? 'Tela')
  return (
    <main className="stage">
      <header className="chat-header">
        <span className="live-badge">AO VIVO</span>
        <strong className="ellipsis">{name}</strong>
        <span className="spacer" />
        <button className="icon-btn" title="Tela cheia" onClick={() => void ref.current?.requestFullscreen()}>
          <Icon name="fullscreen" />
        </button>
        <button className="icon-btn" title="Parar de assistir" onClick={() => watchStream(null)}>
          <Icon name="close" />
        </button>
      </header>
      <div className="stage-video">
        {/* A minha prévia fica muda para não ecoar o áudio do jogo de volta. */}
        <video ref={ref} autoPlay playsInline muted={userId === me?.id} />
        {!hasVideo && <div className="muted center stage-wait">Carregando a transmissão…</div>}
      </div>
    </main>
  )
}
