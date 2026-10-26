import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { CHANNEL_TEXT, CHANNEL_VOICE, type Invite, type Status } from '../types'
import { Avatar, statusLabel } from './Avatar'
import { Modal } from './Modal'

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3)
}

export function GuildBar({ onJoin }: { onJoin: () => void }) {
  const { guildOrder, guilds, selectedGuild, selectGuild, unread } = useStore()
  const [creating, setCreating] = useState(false)
  return (
    <nav className="guildbar">
      {guildOrder.map((id) => {
        const g = guilds[id]
        const hasUnread = g.channels.some((c) => unread[c.id])
        return (
          <button
            key={id}
            className={`guild-icon ${selectedGuild === id ? 'active' : ''} ${hasUnread ? 'unread' : ''}`}
            title={g.name}
            onClick={() => selectGuild(id)}
          >
            {initials(g.name)}
          </button>
        )
      })}
      <div className="guild-sep" />
      <button className="guild-icon add" title="Criar um servidor" onClick={() => setCreating(true)}>
        +
      </button>
      <button className="guild-icon add" title="Entrar com convite" onClick={onJoin}>
        ⇥
      </button>
      {creating && <CreateGuildModal onClose={() => setCreating(false)} />}
    </nav>
  )
}

function CreateGuildModal({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)
  const selectGuild = useStore((s) => s.selectGuild)
  const [name, setName] = useState(`Servidor de ${me?.display_name ?? ''}`)
  const [error, setError] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      const g = await api.createGuild(name)
      // O GUILD_CREATE pode chegar pelo gateway antes ou depois desta resposta.
      const wait = () => (useStore.getState().guilds[g.id] ? selectGuild(g.id) : setTimeout(wait, 50))
      wait()
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <Modal title="Crie seu servidor" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <p className="muted">Um lugar para você e seus amigos. Ele já vem com #geral e um canal de voz.</p>
        <label>
          Nome do servidor
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus required />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary">Criar</button>
      </form>
    </Modal>
  )
}

export function JoinModal({ initialCode, onClose }: { initialCode?: string; onClose: () => void }) {
  const selectGuild = useStore((s) => s.selectGuild)
  const [code, setCode] = useState(initialCode ?? '')
  const [preview, setPreview] = useState<Invite | null>(null)
  const [error, setError] = useState('')

  function parse(v: string) {
    return v.trim().split('/').filter(Boolean).pop() ?? ''
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    try {
      const c = parse(code)
      if (!preview) {
        setPreview(await api.getInvite(c))
        return
      }
      const g = await api.acceptInvite(c)
      const wait = () => (useStore.getState().guilds[g.id] ? selectGuild(g.id) : setTimeout(wait, 50))
      wait()
      onClose()
    } catch (err) {
      setPreview(null)
      setError((err as Error).message)
    }
  }

  return (
    <Modal title="Entrar em um servidor" onClose={onClose}>
      <form onSubmit={submit} className="stack">
        {preview ? (
          <p>
            Você foi convidado para <strong>{preview.guild_name}</strong>.
          </p>
        ) : (
          <label>
            Link ou código do convite
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="http://localhost:5173/invite/hTKzmak2"
              autoFocus
              required
            />
          </label>
        )}
        {error && <div className="error">{error}</div>}
        <button className="primary">{preview ? 'Aceitar convite' : 'Continuar'}</button>
      </form>
    </Modal>
  )
}

export function ChannelSidebar() {
  const { guilds, selectedGuild, selectedChannel, selectChannel, unread, mentioned } = useStore()
  const g = selectedGuild ? guilds[selectedGuild] : null
  const [inviting, setInviting] = useState(false)
  const [creatingKind, setCreatingKind] = useState<number | null>(null)

  return (
    <aside className="sidebar">
      <header className="sidebar-header">
        <span className="ellipsis">{g?.name ?? 'Concord'}</span>
        {g && (
          <button className="icon-btn" title="Convidar pessoas" onClick={() => setInviting(true)}>
            ✉
          </button>
        )}
      </header>
      <div className="channels">
        {g &&
          [CHANNEL_TEXT, CHANNEL_VOICE].map((kind) => (
            <section key={kind}>
              <div className="channel-group">
                <span>{kind === CHANNEL_TEXT ? 'Canais de texto' : 'Canais de voz'}</span>
                <button className="icon-btn small" title="Criar canal" onClick={() => setCreatingKind(kind)}>
                  +
                </button>
              </div>
              {g.channels
                .filter((c) => c.kind === kind)
                .sort((a, b) => a.position - b.position)
                .map((c) =>
                  kind === CHANNEL_TEXT ? (
                    <button
                      key={c.id}
                      className={`channel ${selectedChannel[g.id] === c.id ? 'active' : ''} ${unread[c.id] ? 'unread' : ''}`}
                      onClick={() => selectChannel(g.id, c.id)}
                    >
                      <span className="hash">#</span>
                      <span className="ellipsis">{c.name}</span>
                      {mentioned[c.id] && <span className="badge">@</span>}
                    </button>
                  ) : (
                    <div key={c.id} className="channel voice" title="Voz chega na Fase 3 (LiveKit)">
                      <span className="hash">🔊</span>
                      <span className="ellipsis">{c.name}</span>
                      <span className="soon">em breve</span>
                    </div>
                  ),
                )}
            </section>
          ))}
      </div>
      <UserPanel />
      {inviting && g && <InviteModal guildId={g.id} guildName={g.name} onClose={() => setInviting(false)} />}
      {creatingKind !== null && g && (
        <CreateChannelModal guildId={g.id} kind={creatingKind} onClose={() => setCreatingKind(null)} />
      )}
    </aside>
  )
}

function InviteModal({ guildId, guildName, onClose }: { guildId: string; guildName: string; onClose: () => void }) {
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    api
      .createInvite(guildId)
      .then((inv) => alive && setLink(`${location.origin}/invite/${inv.code}`))
      .catch((err) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [guildId])
  return (
    <Modal title={`Convide amigos para ${guildName}`} onClose={onClose}>
      <div className="stack">
        <p className="muted">Envie este link. Ele expira em 7 dias.</p>
        <div className="row">
          <input readOnly value={link || 'Gerando…'} onFocus={(e) => e.target.select()} />
          <button
            className="primary"
            disabled={!link}
            onClick={() => {
              void navigator.clipboard?.writeText(link)
              setCopied(true)
            }}
          >
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </Modal>
  )
}

function CreateChannelModal({ guildId, kind, onClose }: { guildId: string; kind: number; onClose: () => void }) {
  const selectChannel = useStore((s) => s.selectChannel)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  async function submit(e: FormEvent) {
    e.preventDefault()
    try {
      const c = await api.createChannel(guildId, name, kind)
      if (kind === CHANNEL_TEXT) {
        const wait = () =>
          useStore.getState().guilds[guildId]?.channels.some((x) => x.id === c.id)
            ? selectChannel(guildId, c.id)
            : setTimeout(wait, 50)
        wait()
      }
      onClose()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <Modal title={kind === CHANNEL_TEXT ? 'Criar canal de texto' : 'Criar canal de voz'} onClose={onClose}>
      <form onSubmit={submit} className="stack">
        <label>
          Nome do canal
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === CHANNEL_TEXT ? 'novo-canal' : 'Partida'}
            maxLength={64}
            autoFocus
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary">Criar canal</button>
      </form>
    </Modal>
  )
}

function UserPanel() {
  const { me, myStatus, myActivity, setPresence, logout, connection, simulateDrop } = useStore()
  const [open, setOpen] = useState(false)
  const [activity, setActivity] = useState(myActivity)
  if (!me) return null
  return (
    <div className="user-panel">
      <button className="user-panel-me" onClick={() => setOpen(!open)} title="Status">
        <Avatar user={me} size={32} status={myStatus} />
        <div className="user-panel-names">
          <span className="ellipsis strong">{me.display_name}</span>
          <span className="ellipsis muted small">{myActivity ? `Jogando ${myActivity}` : statusLabel[myStatus]}</span>
        </div>
      </button>
      <span className={`conn ${connection}`} title={`Gateway: ${connection}`} />
      {open && (
        <div className="popover">
          {(['online', 'idle', 'dnd'] as Status[]).map((st) => (
            <button
              key={st}
              className={`popover-item ${myStatus === st ? 'active' : ''}`}
              onClick={() => setPresence(st, myActivity)}
            >
              <span className={`status-dot inline ${st}`} /> {statusLabel[st]}
            </button>
          ))}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setPresence(myStatus, activity.trim())
              setOpen(false)
            }}
          >
            <input value={activity} onChange={(e) => setActivity(e.target.value)} placeholder="Jogando… (ex.: Valorant)" maxLength={64} />
          </form>
          <div className="popover-sep" />
          <button className="popover-item" onClick={simulateDrop} title="Derruba o WebSocket para ver o RESUME">
            Simular queda de conexão
          </button>
          <button className="popover-item danger" onClick={() => void logout()}>
            Sair
          </button>
        </div>
      )}
    </div>
  )
}
