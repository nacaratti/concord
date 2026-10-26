import type { Channel, Guild, Invite, Message, User } from './types'

const TOKEN_KEY = 'concord.token'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* armazenamento indisponível: a sessão dura só esta aba */
  }
}

export class ApiError extends Error {
  status: number
  /** Segundos até poder tentar de novo, quando o servidor respondeu 429. */
  retryAfter: number
  constructor(status: number, message: string, retryAfter = 0) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, data.message ?? `Erro ${res.status}`, data.retry_after ?? 0)
  return data as T
}

interface AuthResponse {
  token: string
  user: User
}

export const api = {
  register: (username: string, password: string, display_name: string) =>
    request<AuthResponse>('POST', '/auth/register', { username, password, display_name }),
  login: (username: string, password: string) => request<AuthResponse>('POST', '/auth/login', { username, password }),
  logout: () => request<void>('POST', '/auth/logout'),

  createGuild: (name: string) => request<Guild>('POST', '/guilds', { name }),
  createChannel: (guildId: string, name: string, kind: number) =>
    request<Channel>('POST', `/guilds/${guildId}/channels`, { name, kind }),
  createInvite: (guildId: string) => request<Invite>('POST', `/guilds/${guildId}/invites`, {}),
  getInvite: (code: string) => request<Invite>('GET', `/invites/${code}`),
  acceptInvite: (code: string) => request<Guild>('POST', `/invites/${code}`),

  messages: (channelId: string, before?: string, limit = 50) =>
    request<Message[]>('GET', `/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`),
  sendMessage: (channelId: string, content: string, nonce: string) =>
    request<Message>('POST', `/channels/${channelId}/messages`, { content, nonce }),
  editMessage: (channelId: string, id: string, content: string) =>
    request<Message>('PATCH', `/channels/${channelId}/messages/${id}`, { content }),
  deleteMessage: (channelId: string, id: string) => request<void>('DELETE', `/channels/${channelId}/messages/${id}`),
  typing: (channelId: string) => request<void>('POST', `/channels/${channelId}/typing`),
  ack: (channelId: string, messageId: string) =>
    request<void>('POST', `/channels/${channelId}/messages/${messageId}/ack`),
}
