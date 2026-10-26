import { create } from 'zustand'
import { api, getToken, setToken } from './api'
import { Gateway, type ConnectionState } from './gateway'
import { CHANNEL_TEXT, type Channel, type Guild, type Member, type Message, type Presence, type User } from './types'

interface State {
  me: User | null
  token: string | null
  connection: ConnectionState
  ready: boolean
  guildOrder: string[]
  guilds: Record<string, Guild>
  presences: Record<string, Presence>
  /** Mensagens por canal, da mais antiga para a mais nova. Só existe para canais já abertos. */
  messages: Record<string, Message[]>
  hasMore: Record<string, boolean>
  loading: Record<string, boolean>
  /** canal → usuário → instante (ms) em que o "digitando" expira */
  typing: Record<string, Record<string, number>>
  unread: Record<string, boolean>
  mentioned: Record<string, boolean>
  selectedGuild: string | null
  selectedChannel: Record<string, string>
  myStatus: Presence['status']
  myActivity: string
}

interface Actions {
  login: (token: string, user: User) => void
  logout: () => Promise<void>
  selectGuild: (id: string) => void
  selectChannel: (guildId: string, channelId: string) => void
  loadMessages: (channelId: string, older?: boolean) => Promise<void>
  sendMessage: (channelId: string, content: string) => Promise<void>
  retryMessage: (channelId: string, nonce: string) => void
  discardMessage: (channelId: string, nonce: string) => void
  setPresence: (status: Presence['status'], activity: string) => void
  simulateDrop: () => void
}

let gateway: Gateway | null = null

const initial: State = {
  me: null,
  token: getToken(),
  connection: 'disconnected',
  ready: false,
  guildOrder: [],
  guilds: {},
  presences: {},
  messages: {},
  hasMore: {},
  loading: {},
  typing: {},
  unread: {},
  mentioned: {},
  selectedGuild: null,
  selectedChannel: {},
  myStatus: 'online',
  myActivity: '',
}

function firstTextChannel(g: Guild): Channel | undefined {
  return g.channels.find((c) => c.kind === CHANNEL_TEXT)
}

function nonce(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 20)
}

/** Insere ou substitui uma mensagem mantendo a ordem por id (Snowflakes são ordenáveis no tempo). */
function upsert(list: Message[], msg: Message): Message[] {
  const out = list.filter((m) => m.id !== msg.id && !(msg.nonce && m.pending && m.nonce === msg.nonce) && !(msg.nonce && m.failed && m.nonce === msg.nonce))
  const confirmed = out.filter((m) => !m.pending && !m.failed)
  const local = out.filter((m) => m.pending || m.failed)
  confirmed.push({ ...msg, pending: false, failed: false })
  confirmed.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
  return [...confirmed, ...local]
}

export function mentionsMe(content: string, me: User | null): boolean {
  if (!me) return false
  return new RegExp(`(^|\\s)@${me.username}\\b`, 'i').test(content)
}

export const useStore = create<State & Actions>()((set, get) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function onDispatch(t: string, d: any) {
    const s = get()
    switch (t) {
      case 'READY': {
        const guilds: Record<string, Guild> = {}
        for (const g of d.guilds as Guild[]) guilds[g.id] = g
        const presences: Record<string, Presence> = {}
        for (const p of d.presences as Presence[]) presences[p.user_id] = p
        const order = (d.guilds as Guild[]).map((g) => g.id)
        // Sessão nova (não RESUME): o cache de mensagens pode ter buracos, descarta.
        set({
          me: d.user,
          ready: true,
          guilds,
          guildOrder: order,
          presences,
          messages: {},
          hasMore: {},
          typing: {},
          selectedGuild: s.selectedGuild && guilds[s.selectedGuild] ? s.selectedGuild : (order[0] ?? null),
        })
        const status = get().myStatus
        if (status !== 'online' || get().myActivity) gateway?.updatePresence(status, get().myActivity)
        const g = get().selectedGuild
        const ch = g ? get().selectedChannel[g] : undefined
        if (ch) void get().loadMessages(ch)
        break
      }
      case 'GUILD_CREATE': {
        const g = d.guild as Guild
        const presences = { ...s.presences }
        for (const p of d.presences as Presence[]) presences[p.user_id] = p
        set({
          guilds: { ...s.guilds, [g.id]: g },
          guildOrder: s.guildOrder.includes(g.id) ? s.guildOrder : [...s.guildOrder, g.id],
          presences,
        })
        break
      }
      case 'GUILD_MEMBER_ADD': {
        const g = s.guilds[d.guild_id]
        if (!g) return
        const m = d.member as Member
        set({
          guilds: { ...s.guilds, [g.id]: { ...g, members: [...g.members.filter((x) => x.user.id !== m.user.id), m] } },
          presences: d.presence.status === 'offline' ? s.presences : { ...s.presences, [m.user.id]: d.presence },
        })
        break
      }
      case 'CHANNEL_CREATE': {
        const c = d as Channel
        const g = s.guilds[c.guild_id]
        if (!g) return
        set({ guilds: { ...s.guilds, [g.id]: { ...g, channels: [...g.channels, c] } } })
        break
      }
      case 'PRESENCE_UPDATE': {
        const p = d as Presence
        const presences = { ...s.presences }
        if (p.status === 'offline') delete presences[p.user_id]
        else presences[p.user_id] = p
        set({ presences })
        break
      }
      case 'MESSAGE_CREATE': {
        const m = d as Message
        const typing = s.typing[m.channel_id]
        if (typing?.[m.author.id]) {
          const rest = { ...typing }
          delete rest[m.author.id]
          set({ typing: { ...s.typing, [m.channel_id]: rest } })
        }
        const viewing = s.selectedGuild === m.guild_id && s.selectedChannel[m.guild_id] === m.channel_id
        if (s.messages[m.channel_id]) {
          set({ messages: { ...s.messages, [m.channel_id]: upsert(s.messages[m.channel_id], m) } })
        }
        if (!viewing && m.author.id !== s.me?.id) {
          set({
            unread: { ...get().unread, [m.channel_id]: true },
            mentioned: mentionsMe(m.content, s.me) ? { ...get().mentioned, [m.channel_id]: true } : get().mentioned,
          })
        }
        break
      }
      case 'MESSAGE_UPDATE': {
        const m = d as Message
        const list = s.messages[m.channel_id]
        if (list) set({ messages: { ...s.messages, [m.channel_id]: list.map((x) => (x.id === m.id ? m : x)) } })
        break
      }
      case 'MESSAGE_DELETE': {
        const list = s.messages[d.channel_id]
        if (list) set({ messages: { ...s.messages, [d.channel_id]: list.filter((x) => x.id !== d.id) } })
        break
      }
      case 'TYPING_START': {
        if (d.user_id === s.me?.id) return
        set({
          typing: { ...s.typing, [d.channel_id]: { ...s.typing[d.channel_id], [d.user_id]: Date.now() + 10_000 } },
        })
        break
      }
    }
  }

  function startGateway(token: string) {
    gateway?.close()
    gateway = new Gateway({
      token,
      onDispatch,
      onState: (connection) => set({ connection }),
      onAuthFailed: () => {
        setToken(null)
        gateway = null
        set({ ...initial, token: null })
      },
    })
    gateway.connect()
  }

  if (initial.token) queueMicrotask(() => startGateway(initial.token!))

  async function deliver(channelId: string, msg: Message) {
    try {
      const real = await api.sendMessage(channelId, msg.content, msg.nonce!)
      const list = get().messages[channelId] ?? []
      set({ messages: { ...get().messages, [channelId]: upsert(list, { ...real, nonce: msg.nonce }) } })
    } catch {
      const list = get().messages[channelId] ?? []
      set({
        messages: {
          ...get().messages,
          [channelId]: list.map((m) => (m.nonce === msg.nonce && m.pending ? { ...m, pending: false, failed: true } : m)),
        },
      })
    }
  }

  return {
    ...initial,

    login(token, user) {
      setToken(token)
      set({ token, me: user })
      startGateway(token)
    },

    async logout() {
      await api.logout().catch(() => {})
      gateway?.close()
      gateway = null
      setToken(null)
      set({ ...initial, token: null })
    },

    selectGuild(id) {
      const g = get().guilds[id]
      if (!g) return
      set({ selectedGuild: id })
      const ch = get().selectedChannel[id] ?? firstTextChannel(g)?.id
      if (ch) get().selectChannel(id, ch)
    },

    selectChannel(guildId, channelId) {
      const unread = { ...get().unread }
      const mentioned = { ...get().mentioned }
      delete unread[channelId]
      delete mentioned[channelId]
      set({ selectedGuild: guildId, selectedChannel: { ...get().selectedChannel, [guildId]: channelId }, unread, mentioned })
      if (!get().messages[channelId]) void get().loadMessages(channelId)
    },

    async loadMessages(channelId, older = false) {
      const s = get()
      if (s.loading[channelId]) return
      const current = s.messages[channelId] ?? []
      const oldest = current.find((m) => !m.pending && !m.failed)
      if (older && (!oldest || s.hasMore[channelId] === false)) return
      set({ loading: { ...s.loading, [channelId]: true } })
      try {
        const page = await api.messages(channelId, older ? oldest!.id : undefined)
        let list = get().messages[channelId] ?? []
        for (const m of page) list = upsert(list, m)
        set({
          messages: { ...get().messages, [channelId]: list },
          hasMore: { ...get().hasMore, [channelId]: page.length === 50 },
        })
      } finally {
        set({ loading: { ...get().loading, [channelId]: false } })
      }
    },

    async sendMessage(channelId, content) {
      const me = get().me!
      const ch = Object.values(get().guilds)
        .flatMap((g) => g.channels)
        .find((c) => c.id === channelId)
      const n = nonce()
      // Atualização otimista: a mensagem aparece já, e é trocada pela real quando o servidor confirma.
      const optimistic: Message = {
        id: `local-${n}`,
        channel_id: channelId,
        guild_id: ch?.guild_id ?? '',
        author: me,
        content,
        edited_at: null,
        timestamp: new Date().toISOString(),
        nonce: n,
        pending: true,
      }
      set({ messages: { ...get().messages, [channelId]: [...(get().messages[channelId] ?? []), optimistic] } })
      await deliver(channelId, optimistic)
    },

    retryMessage(channelId, n) {
      const list = get().messages[channelId] ?? []
      const msg = list.find((m) => m.nonce === n && m.failed)
      if (!msg) return
      set({
        messages: { ...get().messages, [channelId]: list.map((m) => (m === msg ? { ...m, failed: false, pending: true } : m)) },
      })
      void deliver(channelId, msg)
    },

    discardMessage(channelId, n) {
      const list = get().messages[channelId] ?? []
      set({ messages: { ...get().messages, [channelId]: list.filter((m) => !(m.nonce === n && m.failed)) } })
    },

    setPresence(status, activity) {
      set({ myStatus: status, myActivity: activity })
      gateway?.updatePresence(status, activity)
    },

    simulateDrop() {
      gateway?.simulateDrop()
    },
  }
})
