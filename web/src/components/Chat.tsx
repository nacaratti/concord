import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { api } from '../api'
import { mentionsMe, useStore } from '../store'
import type { Channel, Message, User } from '../types'
import { Avatar } from './Avatar'

const EMPTY: Message[] = []
const GROUP_WINDOW_MS = 5 * 60 * 1000

function formatTime(iso: string) {
  const d = new Date(iso)
  const today = new Date()
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === today.toDateString()) return `Hoje às ${time}`
  return `${d.toLocaleDateString('pt-BR')} ${time}`
}

/** Destaca @menções e links no texto da mensagem. */
function renderContent(content: string, me: User | null): ReactNode[] {
  return content.split(/(\s+)/).map((part, i) => {
    if (/^@[a-zA-Z0-9_.]{2,32}$/.test(part)) {
      const self = me && part.slice(1).toLowerCase() === me.username.toLowerCase()
      return (
        <span key={i} className={`mention ${self ? 'self' : ''}`}>
          {part}
        </span>
      )
    }
    if (/^https?:\/\/\S+$/.test(part)) {
      return (
        <a key={i} href={part} target="_blank" rel="noreferrer noopener">
          {part}
        </a>
      )
    }
    return <Fragment key={i}>{part}</Fragment>
  })
}

export function Chat({ channel }: { channel: Channel }) {
  const messages = useStore((s) => s.messages[channel.id] ?? EMPTY)
  const hasMore = useStore((s) => s.hasMore[channel.id])
  const loading = useStore((s) => s.loading[channel.id])
  const loadMessages = useStore((s) => s.loadMessages)
  const listRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)
  const prevHeight = useRef<number | null>(null)

  // Mantém o scroll no fim quando chegam mensagens novas, e no lugar certo quando carrega antigas.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (prevHeight.current !== null) {
      el.scrollTop = el.scrollHeight - prevHeight.current
      prevHeight.current = null
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [messages])

  useEffect(() => {
    stickToBottom.current = true
  }, [channel.id])

  function onScroll() {
    const el = listRef.current!
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (el.scrollTop < 200 && hasMore && !loading) {
      prevHeight.current = el.scrollHeight
      void loadMessages(channel.id, true)
    }
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <span className="hash">#</span>
        <strong>{channel.name}</strong>
      </header>
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {hasMore === false && (
          <div className="channel-start">
            <div className="channel-start-icon">#</div>
            <h2>Boas-vindas a #{channel.name}!</h2>
            <p className="muted">Este é o começo do canal #{channel.name}.</p>
          </div>
        )}
        {loading && messages.length === 0 && <div className="muted center">Carregando…</div>}
        {messages.map((m, i) => {
          const prev = messages[i - 1]
          const grouped =
            prev &&
            prev.author.id === m.author.id &&
            !prev.failed &&
            new Date(m.timestamp).getTime() - new Date(prev.timestamp).getTime() < GROUP_WINDOW_MS
          return <MessageRow key={m.nonce || m.id} message={m} grouped={!!grouped} />
        })}
      </div>
      <Composer channel={channel} />
    </main>
  )
}

function MessageRow({ message: m, grouped }: { message: Message; grouped: boolean }) {
  const me = useStore((s) => s.me)
  const retry = useStore((s) => s.retryMessage)
  const discard = useStore((s) => s.discardMessage)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(m.content)
  const mine = m.author.id === me?.id
  const confirmed = !m.pending && !m.failed
  const highlighted = !mine && mentionsMe(m.content, me)

  async function saveEdit() {
    const content = draft.trim()
    setEditing(false)
    if (content && content !== m.content) await api.editMessage(m.channel_id, m.id, content).catch(() => {})
  }

  return (
    <div className={`message ${grouped ? 'grouped' : ''} ${m.pending ? 'pending' : ''} ${m.failed ? 'failed' : ''} ${highlighted ? 'highlight' : ''}`}>
      {grouped ? (
        <span className="message-gutter-time">
          {new Date(m.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </span>
      ) : (
        <Avatar user={m.author} />
      )}
      <div className="message-body">
        {!grouped && (
          <div className="message-meta">
            <span className="strong">{m.author.display_name}</span>
            <span className="muted small">{formatTime(m.timestamp)}</span>
          </div>
        )}
        {editing ? (
          <div className="edit-box">
            <textarea
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void saveEdit()
                }
                if (e.key === 'Escape') setEditing(false)
              }}
            />
            <span className="muted small">Esc para cancelar · Enter para salvar</span>
          </div>
        ) : (
          <div className="message-content">
            {renderContent(m.content, me)}
            {m.edited_at && <span className="muted small"> (editado)</span>}
          </div>
        )}
        {m.failed && (
          <div className="error small">
            Não foi possível enviar.{' '}
            <button className="link" onClick={() => retry(m.channel_id, m.nonce!)}>
              Tentar de novo
            </button>{' '}
            ·{' '}
            <button className="link" onClick={() => discard(m.channel_id, m.nonce!)}>
              Descartar
            </button>
          </div>
        )}
      </div>
      {mine && confirmed && !editing && (
        <div className="message-actions">
          <button
            title="Editar"
            onClick={() => {
              setDraft(m.content)
              setEditing(true)
            }}
          >
            ✎
          </button>
          <button title="Excluir" onClick={() => void api.deleteMessage(m.channel_id, m.id).catch(() => {})}>
            🗑
          </button>
        </div>
      )}
    </div>
  )
}

function TypingIndicator({ channelId }: { channelId: string }) {
  const typing = useStore((s) => s.typing[channelId])
  const guilds = useStore((s) => s.guilds)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [])
  const ids = Object.entries(typing ?? {})
    .filter(([, until]) => until > now)
    .map(([id]) => id)
  if (ids.length === 0) return <div className="typing" />
  const names = ids.map(
    (id) =>
      Object.values(guilds)
        .flatMap((g) => g.members)
        .find((m) => m.user.id === id)?.user.display_name ?? 'Alguém',
  )
  const text =
    names.length === 1
      ? `${names[0]} está digitando…`
      : names.length <= 3
        ? `${names.slice(0, -1).join(', ')} e ${names.at(-1)} estão digitando…`
        : 'Várias pessoas estão digitando…'
  return (
    <div className="typing">
      <span className="typing-dots">
        <i />
        <i />
        <i />
      </span>
      <strong>{text}</strong>
    </div>
  )
}

function Composer({ channel }: { channel: Channel }) {
  const send = useStore((s) => s.sendMessage)
  const [text, setText] = useState('')
  const lastTyping = useRef(0)
  const ref = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [channel.id])

  function onChange(v: string) {
    setText(v)
    // Avisa "digitando" no máximo a cada 8 s, como o Discord.
    if (v && Date.now() - lastTyping.current > 8000) {
      lastTyping.current = Date.now()
      void api.typing(channel.id).catch(() => {})
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const content = text.trim()
      if (!content) return
      setText('')
      lastTyping.current = 0
      void send(channel.id, content)
    }
  }

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          maxLength={4000}
          placeholder={`Conversar em #${channel.name}`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <TypingIndicator channelId={channel.id} />
    </div>
  )
}
