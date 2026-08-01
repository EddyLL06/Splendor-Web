import { useCallback, useEffect, useRef, useState } from 'react';
import type { LobbyAPI } from 'boardgame.io';
import type { LobbyClient } from 'boardgame.io/client';
import { useTranslation } from 'react-i18next';

import { localizedError, useAuth } from '../auth.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { GAME_NAME } from '../config.js';
import { matchShareURL, type MatchSession } from '../session.js';

const LOBBY_REVALIDATION_INTERVAL_MS = 15_000;

interface LobbyScreenProps {
  lobby: LobbyClient;
  inviteMatchID: string | null;
  onSession: (session: MatchSession) => void;
}

const occupiedSeats = (match: LobbyAPI.Match): number =>
  match.players.filter((player) => Boolean(player.name)).length;

export function LobbyScreen({ lobby, inviteMatchID, onSession }: LobbyScreenProps) {
  const { t } = useTranslation();
  const { user, request } = useAuth();
  const [playerCount, setPlayerCount] = useState(3);
  const [isPrivate, setIsPrivate] = useState(false);
  const [matches, setMatches] = useState<LobbyAPI.Match[]>([]);
  const [inviteMatch, setInviteMatch] = useState<LobbyAPI.Match | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const lastRefreshAt = useRef(0);

  const refresh = useCallback(async () => {
    lastRefreshAt.current = Date.now();
    try {
      const response = await lobby.listMatches(GAME_NAME, { isGameover: false });
      setMatches(response.matches);
      if (inviteMatchID) {
        setInviteMatch(
          response.matches.find((match) => match.matchID === inviteMatchID) ??
            (await lobby.getMatch(GAME_NAME, inviteMatchID)),
        );
      } else {
        setInviteMatch(null);
      }
      setError('');
    } catch (caught) {
      setError(localizedError(caught));
    }
  }, [inviteMatchID, lobby]);

  useEffect(() => {
    const refreshIfStale = () => {
      if (
        lastRefreshAt.current > 0 &&
        (document.visibilityState === 'hidden' ||
          Date.now() - lastRefreshAt.current < LOBBY_REVALIDATION_INTERVAL_MS)
      ) {
        return;
      }
      void refresh();
    };
    refreshIfStale();
    window.addEventListener('focus', refreshIfStale);
    document.addEventListener('visibilitychange', refreshIfStale);
    return () => {
      window.removeEventListener('focus', refreshIfStale);
      document.removeEventListener('visibilitychange', refreshIfStale);
    };
  }, [refresh]);

  const joinMatch = async (match: LobbyAPI.Match) => {
    if (!user) return;
    const ownedSeat = match.players.find(
      (player) => (player.data as { userId?: string } | undefined)?.userId === user.id,
    );
    setBusy(match.matchID);
    setError('');
    try {
      if (ownedSeat) {
        const restored = await request<{ playerID: string; playerCredentials: string; playerName: string }>(
          `/api/matches/${encodeURIComponent(match.matchID)}/reclaim`,
          { method: 'POST' },
        );
        onSession({ matchID: match.matchID, ...restored });
        return;
      }
      const openSeat = match.players.find((player) => !player.name);
      if (!openSeat) throw new Error('MATCH_FULL');
      const joined = await lobby.joinMatch(GAME_NAME, match.matchID, {
        playerID: String(openSeat.id),
        playerName: user.username,
      });
      onSession({
        matchID: match.matchID,
        playerID: joined.playerID,
        playerCredentials: joined.playerCredentials,
        playerName: user.username,
      });
    } catch (caught) {
      setError(caught instanceof Error && caught.message === 'MATCH_FULL'
        ? t('errors.MATCH_FULL')
        : localizedError(caught));
      setBusy('');
      await refresh();
    }
  };

  const createMatch = async () => {
    if (!user) return;
    setBusy('create');
    setError('');
    try {
      const created = await lobby.createMatch(GAME_NAME, {
        numPlayers: playerCount,
        unlisted: isPrivate,
      });
      const joined = await lobby.joinMatch(GAME_NAME, created.matchID, {
        playerID: '0',
        playerName: user.username,
      });
      onSession({
        matchID: created.matchID,
        playerID: joined.playerID,
        playerCredentials: joined.playerCredentials,
        playerName: user.username,
      });
    } catch (caught) {
      setError(localizedError(caught));
      setBusy('');
    }
  };

  const copyInvite = async (matchID: string) => {
    await navigator.clipboard.writeText(matchShareURL(matchID));
    setCopied(matchID);
    window.setTimeout(() => setCopied(''), 1800);
  };

  const openMatches = matches.filter(
    (match) => occupiedSeats(match) < match.players.length,
  );

  return (
    <div className="lobby-shell">
      <header className="lobby-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">◆</div>
          <div><strong>{t('common.appName')}</strong><span>{t('lobby.browserMultiplayer')}</span></div>
        </div>
        <div className="header-account-row">
          <span className="server-chip"><span className="connection-dot online" />{t('lobby.inMemory')}</span>
          <AccountMenu />
        </div>
      </header>
      <main className="lobby-main">
        <section className="lobby-hero">
          <span className="eyebrow">{t('lobby.eyebrow')}</span>
          <h1>{t('lobby.title')}</h1>
          <p>{t('lobby.intro')}</p>
          <div className="hero-rule-row" aria-label={t('lobby.players24')}>
            <span>{t('lobby.players24')}</span><span>{t('lobby.prestige15')}</span><span>{t('lobby.verifiedAccounts')}</span>
          </div>
        </section>
        <section className="lobby-card create-card">
          <div className="section-heading"><div><span className="eyebrow">{t('lobby.newTable')}</span><h2>{t('lobby.start')}</h2></div><span className="step-number">01</span></div>
          <fieldset className="player-count-field">
            <legend>{t('lobby.seats')}</legend>
            <div className="segmented-control">
              {[2, 3, 4].map((count) => (
                <button type="button" key={count} className={playerCount === count ? 'selected' : ''} aria-pressed={playerCount === count} onClick={() => setPlayerCount(count)}>
                  {count}<span>{t('lobby.players', { count })}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="visibility-field">
            <legend>{t('lobby.visibility')}</legend>
            {[false, true].map((privateRoom) => (
              <label key={String(privateRoom)} className={isPrivate === privateRoom ? 'visibility-option selected' : 'visibility-option'}>
                <input type="radio" name="visibility" checked={isPrivate === privateRoom} onChange={() => setIsPrivate(privateRoom)} />
                <span><strong>{t(privateRoom ? 'lobby.private' : 'lobby.public')}</strong><small>{t(privateRoom ? 'lobby.privateHelp' : 'lobby.publicHelp')}</small></span>
              </label>
            ))}
          </fieldset>
          <button type="button" className="button button-primary button-full" disabled={busy !== ''} onClick={() => void createMatch()}>
            {busy === 'create' ? t('lobby.creating') : t('lobby.create')}
          </button>
          <p className="form-note">{t('lobby.createNote')}</p>
        </section>
        {inviteMatchID && (
          <section className="lobby-card invite-card">
            <div className="section-heading"><div><span className="eyebrow">{t('lobby.invitation')}</span><h2>{t('lobby.joinShared')}</h2></div><span className="step-number">02</span></div>
            {inviteMatch ? <>
              <div className="match-id-line"><span>{t('lobby.matchID')}</span><strong>{inviteMatch.matchID}</strong></div>
              <div className="seat-meter"><div><strong>{occupiedSeats(inviteMatch)}</strong><span>{t('lobby.joined')}</span></div><div className="meter-track"><span style={{ width: `${(occupiedSeats(inviteMatch) / inviteMatch.players.length) * 100}%` }} /></div><div><strong>{inviteMatch.players.length}</strong><span>{t('lobby.seatCount')}</span></div></div>
              <button type="button" className="button button-primary button-full" disabled={busy !== '' || (!inviteMatch.players.some((player) => !player.name) && !inviteMatch.players.some((player) => (player.data as { userId?: string } | undefined)?.userId === user?.id))} onClick={() => void joinMatch(inviteMatch)}>
                {busy === inviteMatch.matchID ? t('lobby.joining') : t('lobby.claim')}
              </button>
            </> : <p className="empty-copy">{t('lobby.lookup')}</p>}
          </section>
        )}
        <section className="lobby-card matches-card">
          <div className="section-heading"><div><span className="eyebrow">{t('lobby.openTables')}</span><h2>{t('lobby.joinWaiting')}</h2></div><button type="button" className="text-button" onClick={() => void refresh()}>{t('common.refresh')}</button></div>
          <div className="match-list">
            {openMatches.map((match) => (
              <article className="match-row" key={match.matchID}>
                <div className="match-emblem" aria-hidden="true">{match.players.length}</div>
                <div className="match-info"><strong>{match.matchID}</strong><span>{t('lobby.seatsClaimed', { occupied: occupiedSeats(match), total: match.players.length })}</span></div>
                <div className="match-row-actions">
                  <button type="button" className="icon-button" aria-label={t('lobby.copyInviteFor', { id: match.matchID })} onClick={() => void copyInvite(match.matchID)}>{copied === match.matchID ? '✓' : '↗'}</button>
                  <button type="button" className="button button-ghost button-small" disabled={busy !== ''} onClick={() => void joinMatch(match)}>{t('lobby.join')}</button>
                </div>
              </article>
            ))}
            {openMatches.length === 0 && <div className="empty-state"><span aria-hidden="true">◇</span><strong>{t('lobby.noMatches')}</strong><p>{t('lobby.noMatchesHelp')}</p></div>}
          </div>
        </section>
        {error && <div className="lobby-error" role="alert"><strong>{t('lobby.requestFailed')}</strong><span>{error}</span></div>}
      </main>
      <footer className="lobby-footer"><span>{t('lobby.disappears')}</span><span>{t('lobby.noArtwork')}</span></footer>
    </div>
  );
}
