import { useState, type FormEvent } from 'react'
import { api } from '../api'
import { useStore } from '../store'

export function Auth() {
  const login = useStore((s) => s.login)
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const res =
        mode === 'login' ? await api.login(username, password) : await api.register(username, password, displayName)
      login(res.token, res.user)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-logo">Concord</div>
        <h1>{mode === 'login' ? 'Boas-vindas de volta!' : 'Criar uma conta'}</h1>
        <p className="muted">
          {mode === 'login' ? 'Que bom te ver de novo.' : 'Só precisa de um nome de usuário e uma senha.'}
        </p>
        <label>
          Nome de usuário
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" required />
        </label>
        {mode === 'register' && (
          <label>
            Nome de exibição <span className="muted">(opcional)</span>
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} />
          </label>
        )}
        <label>
          Senha
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 8 : undefined}
            required
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {mode === 'login' ? 'Entrar' : 'Continuar'}
        </button>
        <p className="muted small">
          {mode === 'login' ? 'Precisa de uma conta? ' : 'Já tem uma conta? '}
          <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
            {mode === 'login' ? 'Registre-se' : 'Entrar'}
          </button>
        </p>
      </form>
    </div>
  )
}
