import { useEffect, useState } from 'react'
import { Auth } from './components/Auth'
import { Chat } from './components/Chat'
import { Members } from './components/Members'
import { ChannelSidebar, GuildBar, JoinModal } from './components/Sidebar'
import { Stage } from './components/Voice'
import { useStore } from './store'

/** Lê /invite/<código> da URL uma vez e limpa o caminho. */
function takeInviteFromUrl(): string | undefined {
  const m = location.pathname.match(/^\/invite\/([A-Za-z0-9]+)$/)
  if (!m) return undefined
  history.replaceState(null, '', '/')
  return m[1]
}

const inviteFromUrl = takeInviteFromUrl()

export default function App() {
  const token = useStore((s) => s.token)
  const ready = useStore((s) => s.ready)
  const connection = useStore((s) => s.connection)
  const guilds = useStore((s) => s.guilds)
  const guildOrder = useStore((s) => s.guildOrder)
  const selectedGuild = useStore((s) => s.selectedGuild)
  const selectedChannel = useStore((s) => s.selectedChannel)
  const selectGuild = useStore((s) => s.selectGuild)
  const watching = useStore((s) => s.voice.watching)
  const [joining, setJoining] = useState<{ code?: string } | null>(inviteFromUrl ? { code: inviteFromUrl } : null)

  const guild = selectedGuild ? guilds[selectedGuild] : null
  const channelId = guild ? selectedChannel[guild.id] : undefined
  const channel = guild?.channels.find((c) => c.id === channelId)

  // Depois do READY, abre o primeiro canal de texto do servidor selecionado.
  useEffect(() => {
    if (ready && guild && !channelId) selectGuild(guild.id)
  }, [ready, guild, channelId, selectGuild])

  if (!token) return <Auth />
  if (!ready) {
    return (
      <div className="splash">
        <div className="auth-logo">Concord</div>
        <p className="muted">{connection === 'reconnecting' ? 'Reconectando…' : 'Conectando ao gateway…'}</p>
      </div>
    )
  }

  return (
    <div className="app">
      {connection !== 'connected' && <div className="conn-banner">Conexão perdida. Reconectando…</div>}
      <GuildBar onJoin={() => setJoining({})} />
      <ChannelSidebar />
      {watching ? (
        <Stage userId={watching} />
      ) : channel ? (
        <Chat key={channel.id} channel={channel} />
      ) : (
        <main className="chat empty">
          <div className="empty-state">
            <h2>{guildOrder.length === 0 ? 'Você ainda não está em nenhum servidor' : 'Escolha um canal'}</h2>
            <p className="muted">Crie um servidor com o botão + ou entre em um com um convite.</p>
            <button className="primary" onClick={() => setJoining({})}>
              Entrar com convite
            </button>
          </div>
        </main>
      )}
      {guild && <Members guild={guild} />}
      {joining && <JoinModal initialCode={joining.code} onClose={() => setJoining(null)} />}
    </div>
  )
}
