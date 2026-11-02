import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, RequestError } from '../lib/api';

export function Login() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.login(email, password);
      queryClient.setQueryData(['me'], me);
    } catch (err) {
      setError(err instanceof RequestError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <form onSubmit={submit} noValidate>
        <div>
          <span className="brand-mark" aria-hidden="true" style={{ display: 'inline-block' }} />
          <h1>Brain Capture</h1>
          <p className="hint" style={{ marginTop: 0 }}>
            Private space. Sign in once on each device.
          </p>
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="btn btn-primary btn-block" type="submit" disabled={busy || !email || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  );
}
