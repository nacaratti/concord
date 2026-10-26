import { useStore } from '../store'
import type { Guild } from '../types'
import { Avatar } from './Avatar'

export function Members({ guild }: { guild: Guild }) {
  const presences = useStore((s) => s.presences)
  const sorted = [...guild.members].sort((a, b) => a.user.display_name.localeCompare(b.user.display_name))
  const online = sorted.filter((m) => presences[m.user.id])
  const offline = sorted.filter((m) => !presences[m.user.id])

  return (
    <aside className="members">
      {[
        ['Online', online],
        ['Offline', offline],
      ].map(([label, list]) =>
        (list as typeof sorted).length === 0 ? null : (
          <section key={label as string}>
            <div className="channel-group">
              <span>
                {label as string} — {(list as typeof sorted).length}
              </span>
            </div>
            {(list as typeof sorted).map((m) => {
              const p = presences[m.user.id]
              return (
                <div key={m.user.id} className={`member ${p ? '' : 'offline'}`}>
                  <Avatar user={m.user} size={32} status={p?.status ?? 'offline'} />
                  <div className="member-names">
                    <span className="ellipsis">
                      {m.nickname ?? m.user.display_name}
                      {m.user.id === guild.owner_id && <span title="Dono do servidor"> 👑</span>}
                    </span>
                    {p?.activity && <span className="ellipsis muted small">Jogando {p.activity}</span>}
                  </div>
                </div>
              )
            })}
          </section>
        ),
      )}
    </aside>
  )
}
