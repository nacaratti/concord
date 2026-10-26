import { create } from 'zustand'
import { api, ApiError, getToken, setToken } from './api'
import { Gateway, type ConnectionState } from './gateway'
import { VoiceClient, type VoiceStatus } from './voice'
import {
  type Attachment,
  CHANNEL_TEXT,
  type Channel,
  type Guild,
  type Member,
  type Message,
  type Presence,
  type ReadState,
  type User,
  type VoiceState,
} from './types'

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
  /** Até onde li cada canal, persistido no servidor (read_states). */
  readStates: Record<string, ReadState>
  selectedGuild: string | null
  selectedChannel: Record<string, string>
  myStatus: Presence['status']
  myActivity: string
  /** Quem está em qual call, em todos os meus servidores (por usuário). */
  voiceStates: Record<string, VoiceState>
  /** A minha call. */
  voice: MyVoice
  /** Volume que escolhi para cada pessoa (0 a 2), guardado neste navegador. */
  userVolumes: Record<string, number>
}

export interface MyVoice {
  guildId: string | null
  channelId: string | null
  status: VoiceStatus
  speaking: string[]
  selfMute: boolean
  selfDeaf: boolean
  micError: string | null
  quality: string
  /** Estou compartilhando a minha tela. */
  sharing: boolean
  shareError: string | null
  /** Quem está compartilhando a tela nesta call (visto pelo LiveKit, inclui você). */
  screens: string[]
  /** De quem é a tela que estou assistindo agora. */
  watching: string | null
  /** Push-to-talk ligado: o microfone só transmite enquanto a tecla está apertada. */
  pttMode: boolean
  pttHeld: boolean
}

interface Actions {
  login: (token: string, user: User) => void
  logout: () => Promise<void>
  selectGuild: (id: string) => void
  selectChannel: (guildId: string, channelId: string) => void
  loadMessages: (channelId: string, older?: boolean) => Promise<void>
  sendMessage: (channelId: string, content: string, attachments?: Attachment[]) => Promise<void>
  retryMessage: (channelId: string, nonce: string) => void
  discardMessage: (channelId: string, nonce: string) => void
  setPresence: (status: Presence['status'], activity: string) => void
  simulateDrop: () => void
  joinVoice: (guildId: string, channelId: string) => void
  leaveVoice: () => void
  toggleMute: () => void
  toggleDeaf: () => void
  toggleShare: () => Promise<void>
  watchStream: (userId: string | null) => void
  /** Liga o <video> à tela de alguém; devolve a função que desliga. */
  attachStream: (userId: string, el: HTMLVideoElement) => () => void
  setUserVolume: (userId: string, volume: number) => void
  togglePtt: () => void
  enableNotifications: () => Promise<void>
}

const VOLUMES_KEY = 'concord.volumes'
const PTT_KEY_STORAGE = 'concord.ptt'

function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

declare global {
  interface Window {
    /** Definido pelo app desktop (desktop/src-tauri/src/lib.rs). */
    __CONCORD_DESKTOP__?: { pttKey: string }
    __TAURI__?: { event: { listen: (name: string, cb: (e: { payload: unknown }) => void) => Promise<() => void> } }
  }
}

/** A tecla do push-to-talk: a do app desktop, ou F8 no navegador. */
export const pttKey = window.__CONCORD_DESKTOP__?.pttKey ?? 'F8'
export const isDesktop = !!window.__CONCORD_DESKTOP__

function loadVolumes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(VOLUMES_KEY) ?? '{}')
  } catch {
    return {}
  }
}

const idleVoice: MyVoice = {
  guildId: null,
  channelId: null,
  status: 'idle',
  speaking: [],
  selfMute: false,
  selfDeaf: false,
  micError: null,
  quality: 'unknown',
  sharing: false,
  shareError: null,
  screens: [],
  watching: null,
  pttMode: loadFlag(PTT_KEY_STORAGE),
  pttHeld: false,
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
  readStates: {},
  selectedGuild: null,
  selectedChannel: {},
  myStatus: 'online',
  myActivity: '',
  voiceStates: {},
  voice: idleVoice,
  userVolumes: loadVolumes(),
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
  const name = me.username.replace(/[.]/g, '\\.')
  return new RegExp(`(^|\\s)@${name}\\b`, 'i').test(content)
}

/** Compara Snowflakes (strings de 64 bits) sem perder precisão. */
function newer(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a) return false
  if (!b) return true
  return BigInt(a) > BigInt(b)
}

export function isUnread(c: Channel, readStates: Record<string, ReadState>): boolean {
  return c.kind === CHANNEL_TEXT && newer(c.last_message_id, readStates[c.id]?.last_read_id ?? '0')
}

export function mentionCount(c: Channel, readStates: Record<string, ReadState>): number {
  return readStates[c.id]?.mention_count ?? 0
}

/** Atualiza um canal dentro do mapa de servidores, sem mutar o estado. */
function patchChannel(guilds: Record<string, Guild>, guildId: string, channelId: string, patch: Partial<Channel>) {
  const g = guilds[guildId]
  if (!g) return guilds
  return { ...guilds, [guildId]: { ...g, channels: g.channels.map((c) => (c.id === channelId ? { ...c, ...patch } : c)) } }
}

const ackTimers: Record<string, number> = {}

function byUser(states: VoiceState[] | undefined): Record<string, VoiceState> {
  const out: Record<string, VoiceState> = {}
  for (const vs of states ?? []) out[vs.user_id] = vs
  return out
}

export const useStore = create<State & Actions>()((set, get) => {
  const setVoice = (patch: Partial<MyVoice>) => set({ voice: { ...get().voice, ...patch } })
  const voiceClient = new VoiceClient({
    onStatus: (status) => setVoice({ status }),
    onSpeaking: (speaking) => setVoice({ speaking }),
    onQuality: (quality) => setVoice({ quality }),
    onMicError: (micError) => setVoice({ micError }),
    onScreens: (screens) => {
      const v = get().voice
      setVoice({ screens, watching: v.watching && screens.includes(v.watching) ? v.watching : null })
    },
    onSharing: (sharing) => {
      const v = get().voice
      if (v.sharing === sharing) return
      setVoice({ sharing })
      // O gateway avisa todos (inclusive quem está fora da call) que estou "ao vivo".
      if (v.guildId && v.channelId) gateway?.updateVoiceState(v.guildId, v.channelId, v.selfMute, v.selfDeaf, sharing)
    },
  })

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
        const readStates: Record<string, ReadState> = {}
        for (const rs of d.read_states as ReadState[]) readStates[rs.channel_id] = rs
        // Sessão nova (não RESUME): o cache de mensagens pode ter buracos, descarta.
        set({
          me: d.user,
          ready: true,
          guilds,
          guildOrder: order,
          presences,
          readStates,
          voiceStates: byUser(d.voice_states as VoiceState[]),
          messages: {},
          hasMore: {},
          typing: {},
          selectedGuild: s.selectedGuild && guilds[s.selectedGuild] ? s.selectedGuild : (order[0] ?? null),
        })
        const status = get().myStatus
        if (status !== 'online' || get().myActivity) gateway?.updatePresence(status, get().myActivity)
        // Sessão nova enquanto eu estava em call: registra a call de novo nesta sessão.
        const v = get().voice
        if (v.guildId && v.channelId) gateway?.updateVoiceState(v.guildId, v.channelId, v.selfMute, v.selfDeaf, v.sharing)
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
          voiceStates: { ...s.voiceStates, ...byUser(d.voice_states as VoiceState[]) },
        })
        break
      }
      case 'VOICE_STATE_UPDATE': {
        const vs = d as VoiceState
        const voiceStates = { ...s.voiceStates }
        if (vs.channel_id) voiceStates[vs.user_id] = vs
        else delete voiceStates[vs.user_id]
        set({ voiceStates })
        const v = get().voice
        if (vs.user_id === s.me?.id && v.channelId) {
          const movedToOtherTab = vs.channel_id && vs.session_id !== gateway?.session
          // Saída da minha sessão neste mesmo servidor (ex.: o webhook do LiveKit me tirou). Uma saída
          // de outro servidor é só eu trocando de servidor, e a entrada nova já está a caminho.
          const kicked = !vs.channel_id && vs.session_id === gateway?.session && vs.guild_id === v.guildId
          if (movedToOtherTab || kicked) {
            void voiceClient.disconnect()
            set({ voice: { ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf, pttMode: v.pttMode } })
          }
        }
        break
      }
      case 'VOICE_SERVER_UPDATE': {
        const v = get().voice
        if (v.channelId !== d.channel_id) return
        voiceClient
          .connect(d.endpoint, d.token, micMuted(v), v.selfDeaf, get().userVolumes)
          .catch(() => set({ voice: { ...get().voice, status: 'idle', micError: 'Não foi possível conectar à voz' } }))
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
        if (s.messages[m.channel_id]) {
          set({ messages: { ...get().messages, [m.channel_id]: upsert(get().messages[m.channel_id], m) } })
        }
        set({ guilds: patchChannel(get().guilds, m.guild_id, m.channel_id, { last_message_id: m.id }) })
        if (m.author.id === s.me?.id) {
          // O servidor já marcou como lido até a própria mensagem.
          markRead(m.channel_id, m.id)
        } else if (isViewing(m.channel_id)) {
          ackSoon(m.channel_id)
        } else if (mentionsMe(m.content, s.me)) {
          const rs = get().readStates[m.channel_id] ?? { channel_id: m.channel_id, last_read_id: '0', mention_count: 0 }
          set({ readStates: { ...get().readStates, [m.channel_id]: { ...rs, mention_count: rs.mention_count + 1 } } })
          notifyMention(m)
        }
        break
      }
      case 'MESSAGE_ACK':
        // Outra aba (ou outro dispositivo) leu este canal.
        markRead(d.channel_id, d.message_id)
        break
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

  /** Microfone fechado se mutado, surdo, ou em push-to-talk com a tecla solta. */
  function micMuted(v: MyVoice): boolean {
    return v.selfMute || v.selfDeaf || (v.pttMode && !v.pttHeld)
  }

  function setPttHeld(held: boolean) {
    const v = get().voice
    if (!v.pttMode || v.pttHeld === held) return
    setVoice({ pttHeld: held })
    if (v.channelId) void voiceClient.setMuted(micMuted(get().voice))
  }

  // No app desktop a tecla vem do atalho global (funciona com o jogo em foco). No navegador,
  // só dá para ouvir o teclado com a aba em foco, mas já serve para testar.
  if (window.__TAURI__ && isDesktop) {
    void window.__TAURI__.event.listen('ptt', (e) => setPttHeld(e.payload === true))
  } else {
    window.addEventListener('keydown', (e) => e.key === pttKey && !e.repeat && setPttHeld(true))
    window.addEventListener('keyup', (e) => e.key === pttKey && setPttHeld(false))
    window.addEventListener('blur', () => setPttHeld(false))
  }

  /** Notificação do sistema quando alguém te menciona e você não está olhando o canal. */
  function notifyMention(m: Message) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    const g = get().guilds[m.guild_id]
    const ch = g?.channels.find((c) => c.id === m.channel_id)
    const body = m.content || (m.attachments?.length ? `[${m.attachments.length} anexo(s)]` : '')
    const n = new Notification(`${m.author.display_name} em #${ch?.name ?? 'canal'} (${g?.name ?? 'Concord'})`, {
      body: body.slice(0, 200),
      tag: m.channel_id, // várias menções no mesmo canal substituem a anterior
    })
    n.onclick = () => {
      window.focus()
      get().selectChannel(m.guild_id, m.channel_id)
    }
  }

  function findChannel(channelId: string): Channel | undefined {
    for (const g of Object.values(get().guilds)) {
      const c = g.channels.find((x) => x.id === channelId)
      if (c) return c
    }
  }

  /** O canal está aberto e a janela em foco: o que chega é lido na hora. */
  function isViewing(channelId: string): boolean {
    const s = get()
    return !!s.selectedGuild && s.selectedChannel[s.selectedGuild] === channelId && document.hasFocus()
  }

  function markRead(channelId: string, messageId: string) {
    const rs = get().readStates[channelId]
    if (rs && !newer(messageId, rs.last_read_id) && rs.mention_count === 0) return
    const last = rs && !newer(messageId, rs.last_read_id) ? rs.last_read_id : messageId
    set({ readStates: { ...get().readStates, [channelId]: { channel_id: channelId, last_read_id: last, mention_count: 0 } } })
  }

  /** Marca como lido já na tela e avisa o servidor com um pequeno atraso, agrupando rajadas. */
  function ackSoon(channelId: string) {
    const c = findChannel(channelId)
    if (!c?.last_message_id || !isUnread(c, get().readStates)) return
    markRead(channelId, c.last_message_id)
    window.clearTimeout(ackTimers[channelId])
    ackTimers[channelId] = window.setTimeout(() => {
      const latest = findChannel(channelId)?.last_message_id
      if (latest) void api.ack(channelId, latest).catch(() => {})
    }, 400)
  }

  // Ao voltar para a janela, o canal aberto conta como lido.
  window.addEventListener('focus', () => {
    const s = get()
    const ch = s.selectedGuild ? s.selectedChannel[s.selectedGuild] : undefined
    if (ch) ackSoon(ch)
  })

  async function deliver(channelId: string, msg: Message, attempt = 0) {
    try {
      const real = await api.sendMessage(channelId, msg.content, msg.nonce!, msg.attachments.map((a) => a.id))
      const list = get().messages[channelId] ?? []
      set({ messages: { ...get().messages, [channelId]: upsert(list, { ...real, nonce: msg.nonce }) } })
    } catch (err) {
      // Rate limit: a mensagem fica pendente e sai sozinha quando o balde tiver ficha de novo.
      if (err instanceof ApiError && err.status === 429 && attempt < 5) {
        await new Promise((r) => setTimeout(r, err.retryAfter * 1000 + 50))
        return deliver(channelId, msg, attempt + 1)
      }
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
      get().leaveVoice()
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
      set({ selectedGuild: guildId, selectedChannel: { ...get().selectedChannel, [guildId]: channelId } })
      ackSoon(channelId)
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

    async sendMessage(channelId, content, attachments = []) {
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
        // Na versão otimista os links apontam para a prévia local; a mensagem real traz os do S3.
        attachments,
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

    joinVoice(guildId, channelId) {
      const v = get().voice
      if (v.channelId === channelId && v.status !== 'idle') return
      // O pedido vai pelo gateway; o token chega de volta em VOICE_SERVER_UPDATE.
      setVoice({ guildId, channelId, status: 'connecting', speaking: [], micError: null })
      gateway?.updateVoiceState(guildId, channelId, v.selfMute, v.selfDeaf)
    },

    leaveVoice() {
      const v = get().voice
      if (v.guildId) gateway?.updateVoiceState(v.guildId, null, v.selfMute, v.selfDeaf)
      void voiceClient.disconnect()
      set({ voice: { ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf, pttMode: v.pttMode } })
    },

    toggleMute() {
      const v = get().voice
      const selfMute = !v.selfMute
      // Como no Discord: desmutar enquanto surdo também tira o surdo.
      const selfDeaf = selfMute ? v.selfDeaf : false
      setVoice({ selfMute, selfDeaf })
      void voiceClient.setMuted(micMuted(get().voice))
      voiceClient.setDeafened(selfDeaf)
      if (v.guildId && v.channelId) gateway?.updateVoiceState(v.guildId, v.channelId, selfMute, selfDeaf, v.sharing)
    },

    toggleDeaf() {
      const v = get().voice
      const selfDeaf = !v.selfDeaf
      const selfMute = selfDeaf
      setVoice({ selfMute, selfDeaf })
      voiceClient.setDeafened(selfDeaf)
      void voiceClient.setMuted(micMuted(get().voice))
      if (v.guildId && v.channelId) gateway?.updateVoiceState(v.guildId, v.channelId, selfMute, selfDeaf, v.sharing)
    },

    async toggleShare() {
      const v = get().voice
      setVoice({ shareError: null })
      const err = await voiceClient.setSharing(!v.sharing)
      if (err) setVoice({ shareError: err })
      else if (!v.sharing) setVoice({ watching: get().me?.id ?? null }) // mostra a prévia da própria tela
    },

    watchStream(userId) {
      setVoice({ watching: userId })
    },

    attachStream(userId, el) {
      return voiceClient.watch(userId, el)
    },

    togglePtt() {
      const pttMode = !get().voice.pttMode
      setVoice({ pttMode, pttHeld: false })
      try {
        localStorage.setItem(PTT_KEY_STORAGE, pttMode ? '1' : '0')
      } catch {
        /* sem armazenamento: vale só nesta sessão */
      }
      if (get().voice.channelId) void voiceClient.setMuted(micMuted(get().voice))
    },

    async enableNotifications() {
      if (typeof Notification === 'undefined') return
      await Notification.requestPermission()
      set({}) // força a interface a reler Notification.permission
    },

    setUserVolume(userId, volume) {
      const userVolumes = { ...get().userVolumes, [userId]: volume }
      set({ userVolumes })
      voiceClient.setUserVolume(userId, volume)
      try {
        localStorage.setItem(VOLUMES_KEY, JSON.stringify(userVolumes))
      } catch {
        /* sem armazenamento: vale só nesta sessão */
      }
    },
  }
})
