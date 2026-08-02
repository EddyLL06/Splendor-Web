import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { localizedError, useAuth, type AuthUser } from '../auth.js';
import {
  readTurnSoundPreference,
  writeTurnSoundPreference,
} from '../gameUiState.js';
import { LanguageSwitcher } from './LanguageSwitcher.js';

function ProfileModal({
  onClose,
  returnFocus,
}: {
  onClose: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const { user, request, setUser } = useAuth();
  const [username, setUsername] = useState(user?.username ?? '');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const appRoot = document.getElementById('root');
    const wasInert = appRoot?.inert ?? false;
    const previousOverflow = document.body.style.overflow;
    if (appRoot) appRoot.inert = true;
    document.body.style.overflow = 'hidden';
    const focusFrame = window.requestAnimationFrame(() => usernameRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [])];
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (appRoot) appRoot.inert = wasInert;
      window.requestAnimationFrame(() => returnFocus.current?.focus());
    };
  }, [onClose, returnFocus]);

  if (!user) return null;

  const saveUsername = async () => {
    setBusy('username');
    setError('');
    setMessage('');
    try {
      const result = await request<{ user: AuthUser }>('/api/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
      });
      setUser(result.user);
      setUsername(result.user.username);
      setMessage(t('account.saved'));
    } catch (caught) {
      setError(localizedError(caught));
    } finally {
      setBusy('');
    }
  };

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    setBusy('avatar');
    setError('');
    setMessage('');
    try {
      const body = new FormData();
      body.set('avatar', file);
      const result = await request<{ user: AuthUser }>('/api/profile/avatar', {
        method: 'POST',
        body,
      });
      setUser(result.user);
      setMessage(t('account.saved'));
    } catch (caught) {
      setError(localizedError(caught));
    } finally {
      setBusy('');
    }
  };

  const removeAvatar = async () => {
    setBusy('remove-avatar');
    setError('');
    setMessage('');
    try {
      const result = await request<{ user: AuthUser }>('/api/profile/avatar', {
        method: 'DELETE',
      });
      setUser(result.user);
      setMessage(t('account.saved'));
    } catch (caught) {
      setError(localizedError(caught));
    } finally {
      setBusy('');
    }
  };

  if (typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="modal-backdrop profile-modal-layer"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section ref={dialogRef} className="modal profile-modal" role="dialog" aria-modal="true" aria-labelledby="profile-title">
        <div className="modal-heading">
          <div>
            <span className="eyebrow">{t('account.profile')}</span>
            <h2 id="profile-title">{t('account.title')}</h2>
          </div>
          <button type="button" className="icon-button" aria-label={t('common.close')} onClick={onClose}>×</button>
        </div>
        <p className="modal-copy">{t('account.subtitle')}</p>
        <div className="profile-avatar-row">
          <img className="profile-avatar-large" src={user.avatarUrl} alt="" />
          <div>
            <strong>{t('account.avatar')}</strong>
            <p>{t('account.avatarHint')}</p>
            <div className="profile-actions">
              <label className="button button-ghost button-small file-button">
                {busy === 'avatar' ? t('account.uploading') : t('account.upload')}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={busy !== ''}
                  onChange={(event) => void uploadAvatar(event.target.files?.[0])}
                />
              </label>
              {user.hasCustomAvatar && (
                <button type="button" className="button button-quiet button-small" disabled={busy !== ''} onClick={() => void removeAvatar()}>
                  {busy === 'remove-avatar' ? t('account.removing') : t('account.removeAvatar')}
                </button>
              )}
            </div>
          </div>
        </div>
        <label className="field">
          <span>{t('account.username')}</span>
          <input ref={usernameRef} value={username} maxLength={20} autoComplete="nickname" onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label className="field">
          <span>{t('account.email')}</span>
          <input value={user.email} disabled readOnly />
        </label>
        {error && <div className="inline-error" role="alert">{error}</div>}
        {message && <div className="inline-success" role="status">{message}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onClose}>{t('common.close')}</button>
          <button type="button" className="button button-primary" disabled={busy !== '' || username === user.username} onClick={() => void saveUsername()}>
            {busy === 'username' ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  );
}

export function AccountMenu() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const [profileOpen, setProfileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [turnSound, setTurnSound] = useState(readTurnSoundPreference);
  const identityButtonRef = useRef<HTMLButtonElement>(null);
  const closeProfile = useCallback(() => setProfileOpen(false), []);
  if (!user) return <LanguageSwitcher />;
  return (
    <>
      <div className="account-menu">
        <LanguageSwitcher />
        <label className="turn-sound-toggle">
          <input
            type="checkbox"
            checked={turnSound}
            onChange={(event) => {
              const enabled = event.target.checked;
              setTurnSound(enabled);
              writeTurnSoundPreference(enabled);
            }}
          />
          <span>{t('account.turnSound')}</span>
        </label>
        <button ref={identityButtonRef} type="button" className="account-identity" onClick={() => setProfileOpen(true)}>
          <img src={user.avatarUrl} alt="" />
          <span>{user.username}</span>
        </button>
        <button
          type="button"
          className="button button-quiet button-small"
          disabled={signingOut}
          onClick={async () => {
            setSigningOut(true);
            try { await logout(); } finally { setSigningOut(false); }
          }}
        >
          {signingOut ? t('account.signingOut') : t('account.signOut')}
        </button>
      </div>
      {profileOpen && <ProfileModal onClose={closeProfile} returnFocus={identityButtonRef} />}
    </>
  );
}
