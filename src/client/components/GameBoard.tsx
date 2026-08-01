import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { BoardProps } from 'boardgame.io/react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { NORMAL_COLORS, TOKEN_COLORS } from '../../shared/constants/colors.js';
import { requireCard, requireNoble } from '../../shared/data/gameData.js';
import { applyMainAction } from '../../shared/rules/engine.js';
import {
  getBonuses,
  getScore,
  totalTokens,
} from '../../shared/rules/selectors.js';
import type {
  CardLocation,
  DevelopmentCard,
  MainAction,
  SplendorState,
  Tier,
  TokenColor,
  TokenCounts,
  ActionLogEntry,
} from '../../shared/types/game.js';
import { localizedError } from '../auth.js';
import { matchShareURL } from '../session.js';
import { DevelopmentCardView } from './DevelopmentCardView.js';
import { PaymentPanel } from './PaymentPanel.js';
import { DiscardPanel, NoblePanel } from './ResolutionPanels.js';
import { TokenBadge } from './TokenBadge.js';

interface MoveAPI {
  mainAction: (action: MainAction) => void;
  discardTokens: (tokens: TokenCounts) => void;
  chooseNoble: (nobleID: string) => void;
}

export interface GameBoardProps extends BoardProps<SplendorState> {
  playerNames: Record<string, string>;
  playerAvatars: Record<string, string>;
  accountMenu: ReactNode;
  onLeaveMatch: () => void;
  onReturnToLobby: () => void;
  onPlayAgain: () => Promise<void>;
}

const playerName = (
  names: Record<string, string>,
  playerID: string,
  t: TFunction,
): string => names[playerID] || t('common.player', { number: Number(playerID) + 1 });

const formatActionLog = (entry: ActionLogEntry, t: TFunction): string => {
  if (!entry.i18n) return entry.message;
  const values = { ...entry.i18n.values } as Record<string, unknown>;
  if (Array.isArray(values.colors)) {
    values.colors = values.colors.map((color) => t(`colors.${String(color)}`)).join(', ');
  }
  if (typeof values.color === 'string') values.color = t(`colors.${values.color}`);
  if (values.tokens && typeof values.tokens === 'object') {
    values.tokens = Object.entries(values.tokens as Record<string, number>)
      .filter(([, count]) => count > 0)
      .map(([color, count]) => `${count} ${t(`colors.${color}`)}`)
      .join(', ');
  }
  return t(`logs.${entry.i18n.key}`, values);
};

function PlayerSummary({
  state,
  id,
  name,
  isCurrent,
  isLocal,
  avatarUrl,
}: {
  state: SplendorState;
  id: string;
  name: string;
  isCurrent: boolean;
  isLocal: boolean;
  avatarUrl: string;
}) {
  const { t } = useTranslation();
  const player = state.players[id];
  const bonuses = getBonuses(state, id);
  return (
    <article
      className={`player-summary${isCurrent ? ' player-current' : ''}${
        isLocal ? ' player-local' : ''
      }`}
    >
      <div className="player-heading">
        {avatarUrl && <img className="player-avatar" src={avatarUrl} alt="" />}
        <div>
          <strong>{name}</strong>
          <span>
            {t('game.seat', { number: Number(id) + 1 })}
            {isLocal ? ` · ${t('common.you')}` : ''}
          </span>
        </div>
        <div className="score-pill">
          <strong>{getScore(state, id)}</strong>
          <span>{t('game.prestige')}</span>
        </div>
      </div>
      <div className="player-stats">
        <span>{t('game.cards', { count: player.purchasedCardIds.length })}</span>
        <span>{t('game.reserved', { count: player.reservedCards.length })}</span>
        <span>{t('game.tokens', { count: totalTokens(player.tokens) })}</span>
        <span>{t('game.nobles', { count: player.nobleIds.length })}</span>
      </div>
      <div className="mini-token-row" aria-label={`${name} tokens`}>
        {TOKEN_COLORS.map((color) => (
          <TokenBadge
            key={color}
            color={color}
            count={player.tokens[color]}
            compact
          />
        ))}
      </div>
      <div className="bonus-row" aria-label={`${name} permanent bonuses`}>
        {NORMAL_COLORS.map((color) => (
          <TokenBadge
            key={color}
            color={color}
            count={bonuses[color]}
            compact
          />
        ))}
      </div>
      {player.reservedCards.length > 0 && (
        <div className="public-reservations">
          {player.reservedCards.map((reserved, index) => (
            <span key={`${reserved.tier}-${reserved.cardId ?? index}`}>
              {reserved.cardId ?? t('game.hiddenTier', { tier: reserved.tier })}
            </span>
          ))}
        </div>
      )}
    </article>
  );
}

function NobleTile({ nobleID }: { nobleID: string }) {
  const noble = requireNoble(nobleID);
  return (
    <article className="noble-tile">
      <div className="noble-title">
        <span>{noble.id}</span>
        <strong>{noble.points} ◆</strong>
      </div>
      <div className="noble-requirements">
        {NORMAL_COLORS.filter(
          (color) => noble.requirement[color] > 0,
        ).map((color) => (
          <TokenBadge
            key={color}
            color={color}
            count={noble.requirement[color]}
            compact
          />
        ))}
      </div>
    </article>
  );
}

function TokenTakePanel({
  state,
  playerID,
  currentPlayerID,
  enabled,
  onAction,
}: {
  state: SplendorState;
  playerID: string | null;
  currentPlayerID: string;
  enabled: boolean;
  onAction: (action: MainAction) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<TokenColor[]>([]);
  useEffect(() => {
    setSelected([]);
  }, [currentPlayerID, state.completedTurns]);

  const choose = (color: (typeof NORMAL_COLORS)[number]) => {
    if (!enabled || state.bank[color] < 1) return;
    setSelected((current) => {
      const count = current.filter((entry) => entry === color).length;
      if (count === 2) return [];
      if (count === 1) {
        if (current.length === 1 && state.bank[color] >= 4) {
          return [color, color];
        }
        return current.filter((entry) => entry !== color);
      }
      if (current.length < 3 && new Set(current).size === current.length) {
        return [...current, color];
      }
      return current;
    });
  };

  const action = useMemo<MainAction | null>(() => {
    if (selected.length === 2 && new Set(selected).size === 1) {
      return { type: 'takeSame', color: selected[0] };
    }
    if (selected.length === 3 && new Set(selected).size === 3) {
      return { type: 'takeDifferent', colors: selected };
    }
    return null;
  }, [selected]);

  const validation =
    action && playerID
      ? applyMainAction(state, playerID, currentPlayerID, action)
      : null;
  const guidance = !enabled
    ? playerID === currentPlayerID
      ? t('game.finishResolution')
      : t('game.waitingTurn', { number: Number(currentPlayerID) + 1 })
    : action
      ? validation?.ok
        ? selected.length === 2
          ? t('game.takeTwoReady')
          : t('game.takeThreeReady')
        : t('errors.INVALID_INPUT')
      : t('game.chooseTokens');

  return (
    <section className="action-card">
      <div className="section-heading compact-heading">
        <div>
          <span className="eyebrow">{t('game.mainAction')}</span>
          <h2>{t('game.takeTokens')}</h2>
        </div>
        {selected.length > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={() => setSelected([])}
          >
            {t('game.clear')}
          </button>
        )}
      </div>
      <div className="take-token-grid">
        {NORMAL_COLORS.map((color) => {
          const count = selected.filter((entry) => entry === color).length;
          return (
            <button
              type="button"
              key={color}
              className={`bank-token token-${color}${
                count > 0 ? ' token-selected' : ''
              }`}
              onClick={() => choose(color)}
              disabled={!enabled || state.bank[color] === 0}
              aria-pressed={count > 0}
            >
              <span className="bank-token-name">{t(`colors.${color}`)}</span>
              <strong>{state.bank[color]}</strong>
              {count > 0 && <span className="selection-count">×{count}</span>}
            </button>
          );
        })}
      </div>
      <p className="action-guidance">{guidance}</p>
      <button
        type="button"
        className="button button-primary button-full"
        disabled={!action || !validation?.ok}
        onClick={() => {
          if (action) onAction(action);
        }}
      >
        {t('game.confirmTokens')}
      </button>
    </section>
  );
}

function MarketTier({
  tier,
  state,
  playerID,
  interactive,
  onBuy,
  onReserve,
  onBlindReserve,
}: {
  tier: Tier;
  state: SplendorState;
  playerID: string | null;
  interactive: boolean;
  onBuy: (card: DevelopmentCard, location: CardLocation) => void;
  onReserve: (tier: Tier, cardID: string) => void;
  onBlindReserve: (tier: Tier) => void;
}) {
  const { t } = useTranslation();
  const reserveCount =
    playerID === null ? 3 : state.players[playerID].reservedCards.length;
  const canReserve = interactive && reserveCount < 3;
  return (
    <section className="market-tier">
      <div className="tier-deck">
        <span className="eyebrow">{t('game.development')}</span>
        <h2>{t('game.tier', { tier })}</h2>
        <div className={`deck-stack deck-tier-${tier}`}>
          <span>{state.decks[tier].length}</span>
          <small>{t('game.remaining')}</small>
        </div>
        <button
          type="button"
          className="button button-ghost button-small button-full"
          disabled={!canReserve || state.decks[tier].length === 0}
          title={
            reserveCount >= 3
              ? t('game.threeReserved')
              : state.decks[tier].length === 0
                ? t('game.deckEmpty')
                : t('game.reserveHidden')
          }
          onClick={() => onBlindReserve(tier)}
        >
          {t('game.reserveBlind')}
        </button>
      </div>
      <div className="market-cards">
        {state.market[tier].map((cardID) => {
          const card = requireCard(cardID);
          return (
            <DevelopmentCardView
              key={cardID}
              card={card}
              state={state}
              playerID={playerID}
              location={{ source: 'market', tier, cardId: cardID }}
              interactive={interactive}
              canReserve={canReserve}
              onBuy={onBuy}
              onReserve={() => onReserve(tier, cardID)}
            />
          );
        })}
        {state.market[tier].length === 0 && (
          <div className="empty-market">
            <strong>{t('game.tierExhausted')}</strong>
            <span>{t('game.noCards')}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function GameOverPanel({
  state,
  names,
  onPlayAgain,
  onReturn,
}: {
  state: SplendorState;
  names: Record<string, string>;
  onPlayAgain: () => Promise<void>;
  onReturn: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!state.result) return null;
  const winners = state.result.winners
    .map((id) => playerName(names, id, t))
    .join(' & ');

  return (
    <div className="modal-backdrop">
      <section
        className="modal game-over-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="game-over-title"
      >
        <span className="eyebrow">{t('game.finalStandings')}</span>
        <h2 id="game-over-title">
          {state.result.winners.length > 1 ? t('game.sharedVictory') : t('game.victory')}
        </h2>
        <p className="winner-line">{winners}</p>
        <div className="standings">
          {state.result.standings.map((standing, index) => (
            <div className="standing-row" key={standing.playerID}>
              <span className="standing-rank">{index + 1}</span>
              <strong>{playerName(names, standing.playerID, t)}</strong>
              <span>{t('game.standingPrestige', { count: standing.score })}</span>
              <span>{t('game.standingCards', { count: standing.purchasedCardCount })}</span>
            </div>
          ))}
        </div>
        {error && <div className="inline-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="button button-ghost" onClick={onReturn}>
            {t('game.returnLobby')}
          </button>
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await onPlayAgain();
              } catch (caught) {
                setError(localizedError(caught));
                setBusy(false);
              }
            }}
          >
            {busy ? t('game.preparing') : t('game.playAgain')}
          </button>
        </div>
      </section>
    </div>
  );
}

export function GameBoard(props: GameBoardProps) {
  const { t } = useTranslation();
  const {
    G,
    ctx,
    moves,
    matchID,
    playerID,
    isConnected,
    playerNames,
    playerAvatars,
    accountMenu,
    onLeaveMatch,
    onReturnToLobby,
    onPlayAgain,
  } = props;
  const moveAPI = moves as unknown as MoveAPI;
  const [purchaseTarget, setPurchaseTarget] = useState<{
    card: DevelopmentCard;
    location: CardLocation;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const localID = playerID ?? null;
  const isLocalTurn = localID !== null && ctx.currentPlayer === localID;
  const canTakeMainAction =
    isLocalTurn && G.pending === null && G.result === null;
  const localPlayer = localID === null ? null : G.players[localID];

  useEffect(() => {
    setPurchaseTarget(null);
  }, [ctx.currentPlayer, G.completedTurns]);

  const sendMainAction = (action: MainAction) => {
    moveAPI.mainAction(action);
  };

  return (
    <div className="game-shell">
      <header className="game-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">
            ◆
          </div>
          <div>
            <strong>{t('common.appName')}</strong>
            <span>{t('common.match', { id: matchID })}</span>
          </div>
        </div>
        <div className="turn-banner">
          <span className={`connection-dot${isConnected ? ' online' : ''}`} />
          <div>
            <span>{isLocalTurn ? t('game.yourTurn') : t('game.currentPlayer')}</span>
            <strong>{playerName(playerNames, ctx.currentPlayer, t)}</strong>
          </div>
          {G.finalRound && <span className="final-badge">{t('game.finalRound')}</span>}
        </div>
        <div className="header-actions">
          <button
            type="button"
            className="button button-ghost button-small"
            onClick={async () => {
              await navigator.clipboard.writeText(matchShareURL(matchID));
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1800);
            }}
          >
            {copied ? t('game.linkCopied') : t('game.copyInvite')}
          </button>
          <button
            type="button"
            className="button button-quiet button-small"
            onClick={onLeaveMatch}
          >
            {t('game.leave')}
          </button>
          {accountMenu}
        </div>
      </header>

      <main className="game-layout">
        <aside className="players-column">
          <div className="section-heading compact-heading">
            <div>
              <span className="eyebrow">{t('game.table')}</span>
              <h2>{t('game.players')}</h2>
            </div>
          </div>
          <div className="player-list">
            {G.playerOrder.map((id) => (
              <PlayerSummary
                key={id}
                state={G}
                id={id}
                name={playerName(playerNames, id, t)}
                isCurrent={ctx.currentPlayer === id}
                isLocal={localID === id}
                avatarUrl={playerAvatars[id] ?? ''}
              />
            ))}
          </div>
        </aside>

        <div className="board-column">
          <section className="bank-panel">
            <div>
              <span className="eyebrow">{t('game.supply')}</span>
              <h2>{t('game.bank')}</h2>
            </div>
            <div className="bank-row">
              {TOKEN_COLORS.map((color) => (
                <TokenBadge key={color} color={color} count={G.bank[color]} />
              ))}
            </div>
          </section>

          <section className="nobles-panel">
            <div className="section-heading compact-heading">
              <div>
                <span className="eyebrow">{t('game.visits')}</span>
                <h2>{t('game.availableNobles')}</h2>
              </div>
              <span className="subtle-note">{t('game.oneNoble')}</span>
            </div>
            <div className="nobles-row">
              {G.availableNobleIds.map((nobleID) => (
                <NobleTile key={nobleID} nobleID={nobleID} />
              ))}
              {G.availableNobleIds.length === 0 && (
                <p className="empty-copy">{t('game.noNobles')}</p>
              )}
            </div>
          </section>

          <div className="markets">
            {([3, 2, 1] as const).map((tier) => (
              <MarketTier
                key={tier}
                tier={tier}
                state={G}
                playerID={localID}
                interactive={canTakeMainAction}
                onBuy={(card, location) =>
                  setPurchaseTarget({ card, location })
                }
                onReserve={(selectedTier, cardID) =>
                  sendMainAction({
                    type: 'reserveMarket',
                    tier: selectedTier,
                    cardId: cardID,
                  })
                }
                onBlindReserve={(selectedTier) =>
                  sendMainAction({
                    type: 'reserveDeck',
                    tier: selectedTier,
                  })
                }
              />
            ))}
          </div>
        </div>

        <aside className="actions-column">
          <TokenTakePanel
            state={G}
            playerID={localID}
            currentPlayerID={ctx.currentPlayer}
            enabled={canTakeMainAction}
            onAction={sendMainAction}
          />

          <section className="action-card reserved-section">
            <div className="section-heading compact-heading">
              <div>
                <span className="eyebrow">{t('game.privateHand')}</span>
                <h2>{t('game.yourReserved')}</h2>
              </div>
              <span className="count-badge">
                {localPlayer?.reservedCards.length ?? 0}/3
              </span>
            </div>
            {localPlayer && localPlayer.reservedCards.length > 0 ? (
              <div className="reserved-list">
                {localPlayer.reservedCards.map((reserved, index) => {
                  const card = reserved.cardId
                    ? requireCard(reserved.cardId)
                    : undefined;
                  return card ? (
                    <DevelopmentCardView
                      key={card.id}
                      card={card}
                      state={G}
                      playerID={localID}
                      location={{ source: 'reserved', cardId: card.id }}
                      interactive={canTakeMainAction}
                      onBuy={(selectedCard, location) =>
                        setPurchaseTarget({
                          card: selectedCard,
                          location,
                        })
                      }
                    />
                  ) : (
                    <div className="hidden-reserved" key={index}>
                      {t('game.hiddenCard', { tier: reserved.tier })}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="empty-copy">
                {t('game.reserveHelp')}
              </p>
            )}
          </section>

          <section className="action-card log-section">
            <div className="section-heading compact-heading">
              <div>
                <span className="eyebrow">{t('game.publicHistory')}</span>
                <h2>{t('game.actionLog')}</h2>
              </div>
            </div>
            <ol className="action-log">
              {[...G.actionLog].reverse().map((entry) => (
                <li key={entry.id}>
                  <span className={`log-dot log-${entry.kind}`} />
                  {formatActionLog(entry, t)}
                </li>
              ))}
              {G.actionLog.length === 0 && (
                <li className="empty-copy">{t('game.firstMove')}</li>
              )}
            </ol>
          </section>
        </aside>
      </main>

      {purchaseTarget && localID && (
        <PaymentPanel
          state={G}
          playerID={localID}
          card={purchaseTarget.card}
          location={purchaseTarget.location}
          onCancel={() => setPurchaseTarget(null)}
          onConfirm={(location, payment) => {
            moveAPI.mainAction({ type: 'purchase', location, payment });
            setPurchaseTarget(null);
          }}
        />
      )}

      {G.pending?.type === 'discard' &&
        localID === G.pending.playerID && (
          <DiscardPanel
            state={G}
            playerID={localID}
            currentPlayerID={ctx.currentPlayer}
            onConfirm={(tokens) => moveAPI.discardTokens(tokens)}
          />
        )}

      {G.pending?.type === 'noble' && localID === G.pending.playerID && (
        <NoblePanel
          nobleIDs={G.pending.eligibleNobleIds}
          onChoose={(nobleID) => moveAPI.chooseNoble(nobleID)}
        />
      )}

      <GameOverPanel
        state={G}
        names={playerNames}
        onPlayAgain={onPlayAgain}
        onReturn={onReturnToLobby}
      />
    </div>
  );
}
