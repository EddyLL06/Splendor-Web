import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { jsonRequest, localizedError, useAuth } from '../auth.js';
import { LanguageSwitcher } from '../components/LanguageSwitcher.js';

type Mode = 'login' | 'register' | 'reset';

export function AuthScreen() {
  const { t, i18n } = useTranslation();
  const { request, adoptSession } = useAuth();
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeRequested, setCodeRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const switchMode = (next: Mode) => {
    setMode(next);
    setCodeRequested(false);
    setCode('');
    setPassword('');
    setError('');
    setNotice('');
  };

  const requestCode = async () => {
    setBusy(true);
    setError('');
    try {
      const path = mode === 'register'
        ? '/api/auth/register/request-code'
        : '/api/auth/password-reset/request-code';
      await request(path, jsonRequest({
        email,
        locale: i18n.language === 'zh-CN' ? 'zh-CN' : 'en',
      }));
      setCodeRequested(true);
      setNotice(t('auth.codeSent'));
    } catch (caught) {
      setError(localizedError(caught));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (mode === 'login') {
        adoptSession(await request('/api/auth/login', jsonRequest({ email, password })));
      } else {
        const path = mode === 'register'
          ? '/api/auth/register/complete'
          : '/api/auth/password-reset/complete';
        adoptSession(await request(path, jsonRequest(
          mode === 'register'
            ? { email, username, password, code }
            : { email, password, code },
        )));
      }
    } catch (caught) {
      setError(localizedError(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <header className="auth-topbar">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">◆</div>
          <div><strong>{t('common.appName')}</strong><span>{t('common.version')}</span></div>
        </div>
        <LanguageSwitcher />
      </header>
      <main className="auth-layout">
        <section className="auth-hero">
          <span className="eyebrow">{t('auth.eyebrow')}</span>
          <h1>{t('auth.title')}</h1>
          <p>{t('auth.subtitle')}</p>
        </section>
        <section className="auth-card">
          <div className="auth-tabs" role="tablist">
            {(['login', 'register', 'reset'] as const).map((item) => (
              <button key={item} type="button" role="tab" aria-selected={mode === item} className={mode === item ? 'selected' : ''} onClick={() => switchMode(item)}>
                {t(item === 'login' ? 'auth.signIn' : item === 'register' ? 'auth.createAccount' : 'auth.resetPassword')}
              </button>
            ))}
          </div>
          <form onSubmit={(event) => void submit(event)}>
            <label className="field">
              <span>{t('auth.email')}</span>
              <input type="email" value={email} autoComplete="email" maxLength={254} placeholder={t('auth.emailPlaceholder')} required onChange={(event) => setEmail(event.target.value)} />
            </label>
            {mode === 'register' && (
              <label className="field">
                <span>{t('auth.username')}</span>
                <input value={username} autoComplete="nickname" maxLength={20} placeholder={t('auth.usernamePlaceholder')} required onChange={(event) => setUsername(event.target.value)} />
              </label>
            )}
            {mode !== 'login' && (
              <>
                <button type="button" className="button button-ghost button-full auth-code-button" disabled={busy || !email} onClick={() => void requestCode()}>
                  {busy ? t('auth.sending') : codeRequested ? t('auth.resendCode') : t('auth.requestCode')}
                </button>
                <label className="field">
                  <span>{t('auth.code')}</span>
                  <input inputMode="numeric" pattern="[0-9]{6}" value={code} maxLength={6} placeholder={t('auth.codePlaceholder')} required onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
                </label>
              </>
            )}
            <label className="field">
              <span>{t(mode === 'reset' ? 'auth.newPassword' : 'auth.password')}</span>
              <input type="password" value={password} minLength={10} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required onChange={(event) => setPassword(event.target.value)} />
              {mode !== 'login' && <small>{t('auth.passwordHint')}</small>}
            </label>
            {error && <div className="inline-error" role="alert">{error}</div>}
            {notice && <div className="inline-success" role="status">{notice}</div>}
            <button type="submit" className="button button-primary button-full" disabled={busy || (mode !== 'login' && !codeRequested)}>
              {busy
                ? t(mode === 'login' ? 'auth.signingIn' : 'auth.completing')
                : t(mode === 'login' ? 'auth.signIn' : mode === 'register' ? 'auth.completeRegistration' : 'auth.completeReset')}
            </button>
          </form>
          <p className="form-note">{t('auth.privacy')}</p>
        </section>
      </main>
    </div>
  );
}
