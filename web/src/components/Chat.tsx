import { Fragment, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { api, uploadToStorage } from '../api'
import { mentionsMe, useStore } from '../store'
import type { Attachment, Channel, Message, User } from '../types'
import { Avatar } from './Avatar'
import { Icon } from './Icon'

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
  const addFilesRef = useRef<((files: File[]) => void) | null>(null)
  const [dragging, setDragging] = useState(false)
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
    <main
      className="chat"
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragging(false)
        addFilesRef.current?.([...e.dataTransfer.files])
      }}
    >
      {dragging && <div className="drop-overlay">Solte para enviar em #{channel.name}</div>}
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
      <Composer channel={channel} addFilesRef={addFilesRef} />
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
          m.content && (
            <div className="message-content">
              {renderContent(m.content, me)}
              {m.edited_at && <span className="muted small"> (editado)</span>}
            </div>
          )
        )}
        {m.attachments?.length > 0 && <Attachments items={m.attachments} />}
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

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Anexos de uma mensagem: imagens viram miniatura clicável; o resto, um cartão para baixar. */
function Attachments({ items }: { items: Attachment[] }) {
  return (
    <div className="attachments">
      {items.map((a) => {
        if (a.content_type.startsWith('image/')) {
          // Reserva o espaço certo antes de a imagem carregar, para o chat não "pular" ao rolar.
          const scale = a.width && a.height ? Math.min(1, 400 / a.width, 300 / a.height) : 1
          return (
            <a key={a.id} href={a.url} target="_blank" rel="noreferrer noopener" className="attachment-image">
              <img
                src={a.thumbnail_url ?? a.url}
                alt={a.filename}
                width={a.width ? Math.round(a.width * scale) : undefined}
                height={a.height ? Math.round(a.height * scale) : undefined}
                loading="lazy"
              />
            </a>
          )
        }
        return (
          <a key={a.id} href={a.url} className="attachment-file" rel="noreferrer noopener" download={a.filename}>
            <Icon name="file" size={32} />
            <span className="attachment-file-info">
              <span className="ellipsis">{a.filename}</span>
              <span className="muted small">{formatSize(a.size)}</span>
            </span>
          </a>
        )
      })}
    </div>
  )
}

interface PendingFile {
  key: string
  file: File
  preview: string | null
  progress: number
  error: string | null
  done: Promise<string | null>
}

const MAX_SIZE = 25 * 1024 * 1024

function Composer({ channel, addFilesRef }: { channel: Channel; addFilesRef: RefObject<((files: File[]) => void) | null> }) {
  const send = useStore((s) => s.sendMessage)
  const [text, setText] = useState('')
  const [pending, setPending] = useState<PendingFile[]>([])
  const [notice, setNotice] = useState('')
  const lastTyping = useRef(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    ref.current?.focus()
  }, [channel.id])

  const patch = (key: string, p: Partial<PendingFile>) =>
    setPending((list) => list.map((f) => (f.key === key ? { ...f, ...p } : f)))

  // O envio começa assim que o arquivo é escolhido: quando você aperta Enter, ele quase sempre já subiu.
  function addFiles(files: File[]) {
    setNotice('')
    const room = 10 - pending.length
    if (files.length > room) setNotice('No máximo 10 anexos por mensagem.')
    const added: PendingFile[] = []
    for (const file of files.slice(0, Math.max(0, room))) {
      if (file.size > MAX_SIZE) {
        setNotice(`${file.name} passa de 25 MB.`)
        continue
      }
      const key = crypto.randomUUID()
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
      const done = (async () => {
        try {
          const up = await api.createAttachment(channel.id, file.name, file.size)
          await uploadToStorage(up.upload_url, file, (progress) => patch(key, { progress }))
          patch(key, { progress: 1 })
          return up.id
        } catch (err) {
          patch(key, { error: (err as Error).message })
          return null
        }
      })()
      added.push({ key, file, preview, progress: 0, error: null, done })
    }
    setPending((list) => [...list, ...added])
  }
  useEffect(() => {
    addFilesRef.current = addFiles
  })

  function remove(key: string) {
    setPending((list) => {
      const f = list.find((x) => x.key === key)
      if (f?.preview) URL.revokeObjectURL(f.preview)
      return list.filter((x) => x.key !== key)
    })
  }

  function onChange(v: string) {
    setText(v)
    // Avisa "digitando" no máximo a cada 8 s, como o Discord.
    if (v && Date.now() - lastTyping.current > 8000) {
      lastTyping.current = Date.now()
      void api.typing(channel.id).catch(() => {})
    }
  }

  async function submit() {
    const content = text.trim()
    if (!content && pending.length === 0) return
    if (pending.some((f) => f.error)) {
      setNotice('Remova os anexos que falharam antes de enviar.')
      return
    }
    const files = pending
    setText('')
    setPending([])
    lastTyping.current = 0
    const ids = await Promise.all(files.map((f) => f.done))
    if (ids.some((id) => !id)) {
      setNotice('Algum anexo falhou ao subir; a mensagem não foi enviada.')
      return
    }
    const attachments: Attachment[] = files.map((f, i) => ({
      id: ids[i]!,
      filename: f.file.name,
      size: f.file.size,
      content_type: f.file.type || 'application/octet-stream',
      url: f.preview ?? '',
      thumbnail_url: f.preview ?? undefined,
    }))
    void send(channel.id, content, attachments)
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void submit()
    }
  }

  return (
    <div className="composer-wrap">
      {pending.length > 0 && (
        <div className="pending-files">
          {pending.map((f) => (
            <div key={f.key} className={`pending-file ${f.error ? 'failed' : ''}`} title={f.error ?? f.file.name}>
              {f.preview ? <img src={f.preview} alt="" /> : <Icon name="file" size={40} />}
              <span className="ellipsis small">{f.file.name}</span>
              <span className="muted small">{f.error ? 'Falhou' : formatSize(f.file.size)}</span>
              {!f.error && f.progress < 1 && (
                <span className="progress">
                  <span style={{ width: `${Math.round(f.progress * 100)}%` }} />
                </span>
              )}
              <button className="pending-remove" title="Remover" onClick={() => remove(f.key)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer">
        <button className="icon-btn" title="Anexar arquivo" onClick={() => fileInput.current?.click()}>
          <Icon name="attach" />
        </button>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])])
            e.target.value = ''
          }}
        />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          maxLength={4000}
          placeholder={`Conversar em #${channel.name}`}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length) {
              e.preventDefault()
              addFiles(files)
            }
          }}
        />
      </div>
      {notice ? <div className="error small typing">{notice}</div> : <TypingIndicator channelId={channel.id} />}
    </div>
  )
}
