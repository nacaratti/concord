import { useState } from 'react'
import { useStore } from '../store'
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
  canAdjust: boolean
}) {
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
  const { voice, guilds, leaveVoice } = useStore()
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
        <button className="icon-btn" title="Desconectar" onClick={leaveVoice}>
          <Icon name="hangup" />
        </button>
      </div>
      {voice.micError && <div className="error small">{voice.micError} — você está só ouvindo.</div>}
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
