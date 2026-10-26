export type Snowflake = string

export interface User {
  id: Snowflake
  username: string
  display_name: string
  avatar_key: string | null
}

export const CHANNEL_TEXT = 0
export const CHANNEL_VOICE = 1

export interface Channel {
  id: Snowflake
  guild_id: Snowflake
  name: string
  kind: number
  position: number
  last_message_id: Snowflake | null
}

export interface VoiceState {
  guild_id: Snowflake
  channel_id: Snowflake | null
  user_id: Snowflake
  session_id: string
  self_mute: boolean
  self_deaf: boolean
}

export interface ReadState {
  channel_id: Snowflake
  last_read_id: Snowflake
  mention_count: number
}

export interface Member {
  user: User
  nickname: string | null
  joined_at: string
}

export interface Guild {
  id: Snowflake
  name: string
  owner_id: Snowflake
  channels: Channel[]
  members: Member[]
}

export interface Message {
  id: Snowflake
  channel_id: Snowflake
  guild_id: Snowflake
  author: User
  content: string
  edited_at: string | null
  timestamp: string
  nonce?: string
  /** Só no cliente: mensagem otimista ainda não confirmada, ou que falhou. */
  pending?: boolean
  failed?: boolean
}

export type Status = 'online' | 'idle' | 'dnd' | 'offline'

export interface Presence {
  user_id: Snowflake
  status: Status
  activity?: string
}

export interface Invite {
  code: string
  guild_id: Snowflake
  guild_name: string
  expires_at: string | null
  max_uses: number | null
  uses: number
}
