import { createContext, useContext, useEffect, useState } from 'react'
import { sb } from '../lib/supabase'
import styles from './Auth.module.css'

const AuthContext = createContext(null)
export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined)

  useEffect(() => {
    sb.auth.getSession().then(({ data: { session } }) => setSession(session))
    const { data: { subscription } } = sb.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => subscription.unsubscribe()
  }, [])

  if (session === undefined) return (
    <div className={styles.loading}>Loading…</div>
  )

  return (
    <AuthContext.Provider value={{ session, user: session?.user || null }}>
      {children}
    </AuthContext.Provider>
  )
}

export function LoginPage() {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async () => {
    setError(''); setSuccess(''); setLoading(true)
    if (mode === 'register') {
      if (password !== password2) { setError('Passwords do not match.'); setLoading(false); return }
      if (password.length < 6) { setError('Password must be at least 6 characters.'); setLoading(false); return }
      const { error: err } = await sb.auth.signUp({
        email, password,
        options: { emailRedirectTo: 'https://themazzy.github.io/arcanevault/' },
      })
      if (err) setError(err.message)
      else setSuccess('Account created! Check your email to confirm, then sign in.')
    } else {
      const { error: err } = await sb.auth.signInWithPassword({ email, password })
      if (err) setError(err.message)
    }
    setLoading(false)
  }

  const switchMode = (m) => { setMode(m); setError(''); setSuccess('') }

  return (
    <div className={styles.screen}>
      <div className={styles.box}>
        <div className={styles.logo}>ARCANE<span>VAULT</span></div>
        <div className={styles.sub}>Your personal MTG collection tracker</div>
        <div className={styles.tabs}>
          <button className={`${styles.tab}${mode === 'login' ? ' ' + styles.active : ''}`} onClick={() => switchMode('login')}>Sign In</button>
          <button className={`${styles.tab}${mode === 'register' ? ' ' + styles.active : ''}`} onClick={() => switchMode('register')}>Create Account</button>
        </div>
        <input className={styles.input} type="email" placeholder="Email address"
          value={email} onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} />
        <input className={styles.input} type="password" placeholder="Password"
          value={password} onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} />
        {mode === 'register' && (
          <input className={styles.input} type="password" placeholder="Confirm password"
            value={password2} onChange={e => setPassword2(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && submit()} />
        )}
        <button className={styles.submit} onClick={submit} disabled={loading || !email || !password}>
          {loading ? '…' : mode === 'login' ? 'Sign In' : 'Create Account'}
        </button>
        {error && <div className={styles.error}>{error}</div>}
        {success && <div className={styles.success}>{success}</div>}
      </div>
    </div>
  )
}
