import { useCallback, useEffect, useState } from 'react';
import type { LobbyAPI } from 'boardgame.io';
import type { LobbyClient } from 'boardgame.io/client';
import { useTranslation } from 'react-i18next';

import { localizedError } from '../auth.js';
import { AccountMenu } from '../components/AccountMenu.js';
import { GAME_NAME } from '../config.js';
import { matchShareURL, type MatchSession } from '../session.js';

interface WaitingRoomProps {
  lobby: LobbyClient;
  session: MatchSession;
  onReady: (match: LobbyAPI.Match) => void;
  onLeave: () => Promise<void>;
}

export function WaitingRoom({ lobby, session, onReady, onLeave }: WaitingRoomProps) {
  const { t } = useTranslation();
  const [match, setMatch] = useState<LobbyAPI.Match | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [leaving, setLeaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await lobby.getMatch(GAME_NAME, session.matchID);
      setMatch(next);
      setError('');
      if (next.players.every((player) => Boolean(player.name))) onReady(next);
    } catch (caught) {
      setError(localizedError(caught));
    }
  }, [lobby, onReady, session.matchID]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const occupied = match?.players.filter((player) => player.name).length ?? 1;
  const seats = match?.players.length ?? 0;

  return (
    <div className="waiting-shell">
      <div className="waiting-account"><AccountMenu /></div>
      <div className="waiting-glow" />
      <main className="waiting-card">
        <div className="brand-mark large-mark" aria-hidden="true">◆</div>
        <span className="eyebrow">{t('waiting.eyebrow')}</span>
        <h1>{t('waiting.title')}</h1>
        <p>{t('waiting.intro')}</p>
        <span className="visibility-badge">{t('waiting.visibility', { visibility: t(match?.unlisted ? 'lobby.private' : 'lobby.public') })}</span>
        <div className="waiting-match-id"><span>{t('waiting.matchID')}</span><strong>{session.matchID}</strong><button type="button" className="button button-ghost button-small" onClick={async () => { await navigator.clipboard.writeText(matchShareURL(session.matchID)); setCopied(true); window.setTimeout(() => setCopied(false), 1800); }}>{copied ? t('waiting.copied') : t('waiting.copy')}</button></div>
        <div className="waiting-progress"><div><span>{t('waiting.playersJoined')}</span><strong>{occupied} / {seats || '…'}</strong></div><div className="meter-track"><span style={{ width: seats ? `${(occupied / seats) * 100}%` : '10%' }} /></div></div>
        <div className="seat-list">
          {match?.players.map((player) => {
            const avatarUrl = (player.data as { avatarUrl?: string } | undefined)?.avatarUrl;
            return <div className={`seat-row${player.name ? ' seat-filled' : ''}`} key={player.id}>
              {avatarUrl ? <img className="seat-avatar" src={avatarUrl} alt="" /> : <span className="seat-number">{Number(player.id) + 1}</span>}
              <div><strong>{player.name || t('waiting.openSeat')}</strong><span>{String(player.id) === session.playerID ? t('common.you') : player.name ? t('common.ready') : t('waiting.waitingPlayer')}</span></div>
              <span className="seat-status">{player.name ? '✓' : '…'}</span>
            </div>;
          })}
        </div>
        {error && <div className="inline-error">{error}</div>}
        <button type="button" className="button button-quiet" disabled={leaving} onClick={async () => { setLeaving(true); await onLeave(); }}>
          {leaving ? t('waiting.leaving') : t('waiting.leave')}
        </button>
      </main>
    </div>
  );
}
