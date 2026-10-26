import type { Status, User } from '../types'

const palette = ['#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#00a8fc', '#9b59b6', '#1abc9c']

export function colorFor(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return palette[h % palette.length]
}

export function Avatar({ user, size = 40, status }: { user: User; size?: number; status?: Status }) {
  return (
    <div className="avatar" style={{ width: size, height: size, background: colorFor(user.id), fontSize: size * 0.42 }}>
      {user.display_name.slice(0, 1).toUpperCase()}
      {status && <span className={`status-dot ${status}`} title={statusLabel[status]} />}
    </div>
  )
}

export const statusLabel: Record<Status, string> = {
  online: 'Disponível',
  idle: 'Ausente',
  dnd: 'Não perturbar',
  offline: 'Offline',
}
