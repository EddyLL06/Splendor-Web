import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { BoardProps } from 'boardgame.io/react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { NORMAL_COLORS, TOKEN_COLORS } from '../../shared/constants/colors.js';
import { requireCard, requireNoble } from '../../shared/data/gameData.js';
import { applyMainAction, suggestedDiscard } from '../../shared/rules/engine.js';
import {
  analyzePayment,
  getBonuses,
  getScore,
  totalTokens,
} from '../../shared/rules/selectors.js';
import type {
  ActionAnimation,
  CardLocation,
  DevelopmentCard,
  MainAction,
  ReservedDevelopmentCard,
  SplendorState,
  Tier,
  TokenColor,
  TokenCounts,
} from '../../shared/types/game.js';
import type {
  PlayerConnectionStatus,
  PublicRoomState,
} from '../../shared/types/room.js';
import type { BotDifficulty } from '../../shared/ai/types.js';
import { localizedError } from '../auth.js';
import {
  canShowReservedCardDetails,
  detectActionAnimation,
  formatActionLog,
  playTurnSound,
  readTurnSoundPreference,
  reduceCardActionMode,
  reduceDiscardUi,
  shouldNotifyLocalTurn,
  type CardActionMode,
} from '../gameUiState.js';
import { matchShareURL } from '../session.js';
import { DevelopmentCardView } from './DevelopmentCardView.js';
import { PaymentPanel } from './PaymentPanel.js';
import { DiscardPanel, NoblePanel } from './ResolutionPanels.js';
import { TokenBadge } from './TokenBadge.js';
import { SpectatorPopover } from './SpectatorPopover.js';

interface MoveAPI {
  mainAction: (action: MainAction) => void;
  discardTokens: (tokens: TokenCounts) => void;
  chooseNoble: (nobleID: string) => void;
}

export interface GameBoardProps extends BoardProps<SplendorState> {
  playerNames: Record<string, string>;
  playerAvatars: Record<string, string>;
  playerConnections?: Record<string, PlayerConnectionStatus>;
  playerDifficulties?: Record<string, BotDifficulty>;
  accountMenu: ReactNode;
  sessionMode: 'player' | 'spectator';
  room: PublicRoomState;
  onLeaveMatch: () => void;
  onReturnToLobby: () => void;
  onPlayAgain?: () => Promise<void>;
  onWatchRematch?: () => Promise<void>;
}

interface PopoverPosition {
  top: number;
  left: number;
}

interface RectSnapshot {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CardFlight {
  id: string;
  kind: 'outgoing' | 'replacement' | 'generic';
  label: string;
  card?: DevelopmentCard;
  from: RectSnapshot;
  to: RectSnapshot;
  delay: number;
}

const playerName = (
  names: Record<string, string>,
  playerID: string,
  t: TFunction,
): string => names[playerID] || t('common.player', { number: Number(playerID) + 1 });

const collectAnimationRects = (): Map<string, RectSnapshot> => {
  const rects = new Map<string, RectSnapshot>();
  if (typeof document === 'undefined') return rects;
  for (const element of document.querySelectorAll<HTMLElement>('[data-animation-key]')) {
    const key = element.dataset.animationKey;
    if (!key) continue;
    const rect = element.getBoundingClientRect();
    rects.set(key, {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    });
  }
  return rects;
};

const flightStyle = (flight: CardFlight): CSSProperties =>
  ({
    top: flight.from.top,
    left: flight.from.left,
    width: flight.from.width,
    height: flight.from.height,
    '--flight-x': `${flight.to.left - flight.from.left}px`,
    '--flight-y': `${flight.to.top - flight.from.top}px`,
    '--flight-width': `${flight.kind === 'replacement'
      ? flight.to.width
      : Math.max(96, Math.min(flight.from.width * 0.72, flight.to.width * 0.36))}px`,
    '--flight-height': `${flight.kind === 'replacement'
      ? flight.to.height
      : Math.max(76, Math.min(flight.from.height * 0.72, flight.to.height * 0.68))}px`,
    '--flight-delay': `${flight.delay}ms`,
  }) as CSSProperties;

function ReservedCardSummary({
  reserved,
  ownerID,
  index,
}: {
  reserved: ReservedDevelopmentCard;
  ownerID: string;
  index: number;
}) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition>({ top: 12, left: 12 });
  const visible = canShowReservedCardDetails(reserved.cardId);
  const card = visible && reserved.cardId ? requireCard(reserved.cardId) : null;

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const previewRect = popoverRef.current?.getBoundingClientRect();
      const width = previewRect?.width ?? Math.min(244, window.innerWidth - 24);
      const previewHeight = previewRect?.height ?? 132;
      const above = rect.top - previewHeight - 10;
      setPosition({
        top: above >= 8 ? above : Math.min(window.innerHeight - previewHeight - 8, rect.bottom + 8),
        left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.left + rect.width / 2 - width / 2)),
      });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  if (!card) {
    return (
      <span className="reserved-summary reserved-summary-hidden">
        {t('game.hiddenTier', { tier: reserved.tier })}
      </span>
    );
  }

  const popover = open && typeof document !== 'undefined'
    ? createPortal(
        <div
          id={`reserved-preview-${ownerID}-${index}`}
          ref={popoverRef}
          className="reserved-card-preview"
          role="tooltip"
          style={position}
        >
          <DevelopmentCardView card={card} variant="preview" />
        </div>,
        document.body,
      )
    : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="reserved-summary"
        aria-describedby={open ? `reserved-preview-${ownerID}-${index}` : undefined}
        aria-expanded={open}
        data-animation-key={`reserved-summary-${ownerID}-${card.id}`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          window.requestAnimationFrame(() => {
            if (!popoverRef.current?.contains(document.activeElement)) setOpen(false);
          });
        }}
        onClick={() => setOpen((current) => !current)}
      >
        {card.id}
      </button>
      {popover}
    </>
  );
}

function PlayerSummary({
  state,
  id,
  name,
  isCurrent,
  isLocal,
  avatarUrl,
  connectionStatus,
  difficulty,
}: {
  state: SplendorState;
  id: string;
  name: string;
  isCurrent: boolean;
  isLocal: boolean;
  avatarUrl: string;
  connectionStatus: PlayerConnectionStatus;
  difficulty?: BotDifficulty;
}) {
  const { t } = useTranslation();
  const player = state.players[id];
  const bonuses = getBonuses(state, id);
  return (
    <article
      className={`player-summary${isCurrent ? ' player-current' : ''}${
        isLocal ? ' player-local' : ''
      }`}
      data-animation-key={`player-${id}`}
    >
      <div className="player-heading">
        {avatarUrl && <img className="player-avatar" src={avatarUrl} alt="" />}
        <div>
          <strong>{name}</strong>
          <span>
            {t('game.seat', { number: Number(id) + 1 })}
            {isLocal ? ` · ${t('common.you')}` : ''}
          </span>
          {difficulty && (
            <span className="bot-difficulty-badge">
              {t('waiting.botBadge')} · {t(`waiting.bot${difficulty[0].toUpperCase()}${difficulty.slice(1)}`)}
            </span>
          )}
          <span
            className={`player-connection-status connection-${connectionStatus}`}
            aria-label={t('game.connectionStatus', {
              player: name,
              status: t(`game.connection.${connectionStatus}`),
            })}
          >
            <span className="player-connection-dot" aria-hidden="true" />
            {t(`game.connection.${connectionStatus}`)}
          </span>
        </div>
        <div className="score-pill">
          <strong>{getScore(state, id)}</strong>
          <span>{t('game.prestige')}</span>
        </div>
      </div>
      <div className="player-stats">
        <span>{t('game.tokens', { count: totalTokens(player.tokens) })}</span>
        <span>{t('game.cards', { count: player.purchasedCardIds.length })}</span>
        <span>{t('game.nobles', { count: player.nobleIds.length })}</span>
        <span>{t('game.reserved', { count: player.reservedCards.length })}</span>
      </div>
      <div className="mini-token-row" aria-label={t('game.playerTokens', { player: name, count: totalTokens(player.tokens) })}>
        {TOKEN_COLORS.map((color) => (
          <TokenBadge key={color} color={color} count={player.tokens[color]} compact />
        ))}
      </div>
      <div className="bonus-row" aria-label={t('game.playerBonuses', { player: name })}>
        {NORMAL_COLORS.map((color) => (
          <TokenBadge key={color} color={color} count={bonuses[color]} compact />
        ))}
      </div>
      <div className="public-reservations" aria-label={t('game.reservedSummary')}>
        {player.reservedCards.length > 0 ? (
          player.reservedCards.map((reserved, index) => (
            <ReservedCardSummary
              key={`${reserved.tier}-${reserved.cardId ?? `hidden-${index}`}`}
              reserved={reserved}
              ownerID={id}
              index={index}
            />
          ))
        ) : (
          <span className="reserved-summary-empty">{t('game.noReserved')}</span>
        )}
      </div>
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
        {NORMAL_COLORS.filter((color) => noble.requirement[color] > 0).map((color) => (
          <TokenBadge key={color} color={color} count={noble.requirement[color]} compact />
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
  blockedGuidance,
  resetKey,
  onAction,
}: {
  state: SplendorState;
  playerID: string | null;
  currentPlayerID: string;
  enabled: boolean;
  blockedGuidance?: string;
  resetKey: string;
  onAction: (action: MainAction) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<TokenColor[]>([]);
  useEffect(() => setSelected([]), [currentPlayerID, state.completedTurns, resetKey]);

  const choose = (color: (typeof NORMAL_COLORS)[number]) => {
    if (!enabled || state.bank[color] < 1) return;
    setSelected((current) => {
      const count = current.filter((entry) => entry === color).length;
      if (count === 2) return [];
      if (count === 1) {
        if (current.length === 1 && state.bank[color] >= 4) return [color, color];
        return current.filter((entry) => entry !== color);
      }
      if (current.length < 3 && new Set(current).size === current.length) return [...current, color];
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

  const validation = action && playerID
    ? applyMainAction(state, playerID, currentPlayerID, action)
    : null;
  const guidance = !enabled
    ? blockedGuidance ?? (playerID === currentPlayerID
        ? t('game.finishResolution')
        : t('game.waitingTurn', { player: t('common.player', { number: Number(currentPlayerID) + 1 }) }))
    : action
      ? validation?.ok
        ? selected.length === 2 ? t('game.takeTwoReady') : t('game.takeThreeReady')
        : t('errors.INVALID_INPUT')
      : t('game.chooseTokens');

  return (
    <section className="action-card token-take-panel">
      <div className="section-heading compact-heading">
        <div>
          <span className="eyebrow">{t('game.mainAction')}</span>
          <h2>{t('game.takeTokens')}</h2>
        </div>
        <div className="gold-joker-info" aria-label={t('game.goldJokerRemaining', { count: state.bank.gold })}>
          <TokenBadge color="gold" count={state.bank.gold} compact />
        </div>
      </div>
      <div className="take-token-grid">
        {NORMAL_COLORS.map((color) => {
          const count = selected.filter((entry) => entry === color).length;
          return (
            <button
              type="button"
              key={color}
              className={`bank-token token-${color}${count > 0 ? ' token-selected' : ''}`}
              onClick={() => choose(color)}
              disabled={!enabled || state.bank[color] === 0}
              aria-pressed={count > 0}
              aria-label={t('game.gemBankCount', { color: t(`colors.${color}`), count: state.bank[color] })}
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
        disabled={!enabled || !action || !validation?.ok}
        onClick={() => action && onAction(action)}
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
  mode,
  interactive,
  replacingSlot,
  onBuy,
  onReserve,
  onBlindReserve,
}: {
  tier: Tier;
  state: SplendorState;
  playerID: string | null;
  mode: CardActionMode;
  interactive: boolean;
  replacingSlot: string | null;
  onBuy: (card: DevelopmentCard, location: CardLocation) => void;
  onReserve: (tier: Tier, cardID: string) => void;
  onBlindReserve: (tier: Tier) => void;
}) {
  const { t } = useTranslation();
  const reserveCount = playerID === null ? 3 : state.players[playerID].reservedCards.length;
  const canReserve = interactive && reserveCount < 3;
  const deckSelectable = mode === 'reserve' && canReserve && state.decks[tier].length > 0;
  const deckContent = (
    <>
      <span>{state.decks[tier].length}</span>
      <small>{t('game.remaining')}</small>
      {mode === 'reserve' && (
        <em>{deckSelectable ? t('game.selectBlindDeck') : t('game.deckUnavailable')}</em>
      )}
    </>
  );

  return (
    <section className="market-tier">
      <div className="tier-deck">
        <span className="eyebrow">{t('game.development')}</span>
        <h2>{t('game.tier', { tier })}</h2>
        {mode === 'reserve' ? (
          <button
            type="button"
            className={`deck-stack deck-tier-${tier}${deckSelectable ? ' deck-selectable' : ''}`}
            disabled={!deckSelectable}
            onClick={() => onBlindReserve(tier)}
            data-animation-key={`deck-${tier}`}
            aria-label={t('game.reserveBlindTier', { tier })}
          >
            {deckContent}
          </button>
        ) : (
          <div className={`deck-stack deck-tier-${tier}`} data-animation-key={`deck-${tier}`}>
            {deckContent}
          </div>
        )}
      </div>
      <div className="market-cards">
        {state.market[tier].map((cardID, slotIndex) => {
          const slotKey = `${tier}-${slotIndex}`;
          if (cardID === null) {
            return (
              <div
                className="empty-market-slot"
                key={`market-slot-${slotIndex}`}
                data-animation-key={`market-${tier}-${slotIndex}`}
              >
                <strong>{t('game.emptySlot')}</strong>
                <span>{t('game.noReplacement')}</span>
              </div>
            );
          }
          const card = requireCard(cardID);
          const canBuy = mode === 'buy' && interactive && playerID !== null &&
            analyzePayment(state, playerID, card).errors.length === 0;
          const selectable = canBuy || (mode === 'reserve' && canReserve);
          return (
            <DevelopmentCardView
              key={`market-slot-${slotIndex}`}
              card={card}
              mode={mode}
              selectable={selectable}
              replacing={replacingSlot === slotKey}
              animationKey={`market-${tier}-${slotIndex}`}
              onSelect={() => {
                if (mode === 'buy') onBuy(card, { source: 'market', tier, cardId: cardID });
                if (mode === 'reserve') onReserve(tier, cardID);
              }}
            />
          );
        })}
      </div>
    </section>
  );
}

function GameOverPanel({
  state,
  names,
  room,
  onPlayAgain,
  onWatchRematch,
  onReturn,
}: {
  state: SplendorState;
  names: Record<string, string>;
  room: PublicRoomState;
  onPlayAgain?: () => Promise<void>;
  onWatchRematch?: () => Promise<void>;
  onReturn: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!state.result) return null;
  const winners = state.result.winners.map((id) => playerName(names, id, t)).join(' & ');
  return (
    <div className="modal-backdrop">
      <section className="modal game-over-modal" role="dialog" aria-modal="true" aria-labelledby="game-over-title">
        <span className="eyebrow">{t('game.finalStandings')}</span>
        <h2 id="game-over-title">
          {state.result.winners.length > 1 ? t('game.sharedVictory') : t('game.victory')}
        </h2>
        <p className="winner-line">{winners}</p>
        <div className="game-over-spectators"><SpectatorPopover room={room} /></div>
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
          <button type="button" className="button button-ghost" onClick={onReturn}>{t('game.returnLobby')}</button>
          {onPlayAgain && (
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
          )}
          {onWatchRematch && (
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await onWatchRematch();
                } catch (caught) {
                  setError(localizedError(caught));
                  setBusy(false);
                }
              }}
            >
              {busy ? t('game.preparing') : t('game.watchRematch')}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

const animationOriginKeys = (animation: ActionAnimation): string[] => {
  if (animation.type === 'market-card') {
    return [`market-${animation.tier}-${animation.slotIndex}`];
  }
  if (animation.type === 'reserve-deck') return [`deck-${animation.tier}`];
  return [
    `reserved-detail-${animation.playerID}-${animation.cardId}`,
    `reserved-summary-${animation.playerID}-${animation.cardId}`,
    `player-${animation.playerID}`,
  ];
};

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
    playerConnections = {},
    playerDifficulties = {},
    accountMenu,
    sessionMode,
    room,
    onLeaveMatch,
    onReturnToLobby,
    onPlayAgain,
    onWatchRematch,
  } = props;
  const moveAPI = moves as unknown as MoveAPI;
  const localID = playerID ?? null;
  const isSpectator = sessionMode === 'spectator';
  const localPlayer = localID === null ? null : G.players[localID];
  const isLocalTurn = localID !== null && ctx.currentPlayer === localID;
  const canTakeMainAction = isLocalTurn && isConnected !== false && G.pending === null && G.result === null;
  const [purchaseTarget, setPurchaseTarget] = useState<{ card: DevelopmentCard; location: CardLocation } | null>(null);
  const [actionMode, setActionMode] = useState<CardActionMode>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [turnNotice, setTurnNotice] = useState(0);
  const [turnNoticeVisible, setTurnNoticeVisible] = useState(false);
  const [discardUi, setDiscardUi] = useState(() => ({
    hidden: false,
    returned: null as TokenCounts | null,
  }));
  const [flights, setFlights] = useState<CardFlight[]>([]);
  const [replacingSlot, setReplacingSlot] = useState<string | null>(null);
  const previousTurnRef = useRef<{ currentPlayer: string | null; localPlayer: string | null }>({
    currentPlayer: null,
    localPlayer: null,
  });
  const discardKeyRef = useRef<string | null>(null);
  const resumeDiscardRef = useRef<HTMLButtonElement>(null);
  const previousRectsRef = useRef<Map<string, RectSnapshot>>(new Map());
  const pendingOriginRectsRef = useRef<Map<string, RectSnapshot> | null>(null);
  const processedLogIDRef = useRef<number | null>(null);
  const animationTimerRef = useRef<number | null>(null);
  const submitTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const previous = previousTurnRef.current;
    if (shouldNotifyLocalTurn(previous, ctx.currentPlayer, localID, G.result !== null)) {
      setTurnNotice((current) => current + 1);
      setTurnNoticeVisible(true);
      if (readTurnSoundPreference()) playTurnSound();
      const timeout = window.setTimeout(() => setTurnNoticeVisible(false), 800);
      previousTurnRef.current = { currentPlayer: ctx.currentPlayer, localPlayer: localID };
      return () => window.clearTimeout(timeout);
    }
    previousTurnRef.current = { currentPlayer: ctx.currentPlayer, localPlayer: localID };
  }, [ctx.currentPlayer, G.result, localID]);

  useEffect(() => {
    setActionMode(null);
    setPurchaseTarget(null);
    setIsSubmitting(false);
  }, [ctx.currentPlayer, G.completedTurns, G.pending?.type, G.result, isConnected]);

  useEffect(() => {
    const key = G.pending?.type === 'discard' && localID === G.pending.playerID
      ? `${G.pending.playerID}:${G.pending.count}:${G.completedTurns}`
      : null;
    if (key && discardKeyRef.current !== key && localID) {
      discardKeyRef.current = key;
      setDiscardUi((current) => reduceDiscardUi(current, {
        type: 'start',
        returned: suggestedDiscard(G, localID),
      }));
    } else if (!key) {
      discardKeyRef.current = null;
      setDiscardUi((current) => reduceDiscardUi(current, { type: 'reset' }));
    }
  }, [G, G.completedTurns, G.pending, localID]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setActionMode(null);
      setPurchaseTarget(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => () => {
    if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current);
    if (submitTimerRef.current !== null) window.clearTimeout(submitTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const currentRects = collectAnimationRects();
    const latestLogID = G.actionLog.at(-1)?.id ?? 0;
    if (processedLogIDRef.current === null) {
      processedLogIDRef.current = latestLogID;
      previousRectsRef.current = currentRects;
      return;
    }
    const detected = detectActionAnimation(G.actionLog, processedLogIDRef.current);
    if (detected.processedThrough === processedLogIDRef.current) {
      previousRectsRef.current = currentRects;
      return;
    }
    processedLogIDRef.current = detected.processedThrough;
    const entry = detected.entry;
    const animation = entry?.animation;
    if (!animation || !entry) {
      pendingOriginRectsRef.current = null;
      previousRectsRef.current = currentRects;
      return;
    }
    const originRects = pendingOriginRectsRef.current ?? previousRectsRef.current;
    pendingOriginRectsRef.current = null;
    const destination = currentRects.get(`player-${animation.playerID}`);
    const origin = animationOriginKeys(animation)
      .map((key) => originRects.get(key))
      .find((rect): rect is RectSnapshot => rect !== undefined) ?? destination;
    const nextFlights: CardFlight[] = [];
    if (origin && destination) {
      const card = animation.type === 'reserve-deck'
        ? undefined
        : requireCard(animation.cardId);
      nextFlights.push({
        id: `${entry.id}-out`,
        kind: animation.type === 'reserve-deck' ? 'generic' : 'outgoing',
        label: animation.type === 'market-card'
          ? animation.cardId
          : animation.type === 'reserved-purchase'
            ? animation.cardId
            : t('game.hiddenCardFace'),
        card,
        from: origin,
        to: destination,
        delay: 0,
      });
    }
    if (animation.type === 'market-card' && animation.replacementCardId) {
      const deck = currentRects.get(`deck-${animation.tier}`)
        ?? originRects.get(`deck-${animation.tier}`);
      const slot = currentRects.get(`market-${animation.tier}-${animation.slotIndex}`);
      if (deck && slot) {
        nextFlights.push({
          id: `${entry.id}-replacement`,
          kind: 'replacement',
          label: animation.replacementCardId,
          card: requireCard(animation.replacementCardId),
          from: deck,
          to: slot,
          delay: 720,
        });
        setReplacingSlot(`${animation.tier}-${animation.slotIndex}`);
      }
    }
    setFlights(nextFlights);
    if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current);
    animationTimerRef.current = window.setTimeout(() => {
      setFlights([]);
      setReplacingSlot(null);
    }, 1700);
    previousRectsRef.current = currentRects;
  }, [G.actionLog, t]);

  const sendMainAction = (action: MainAction) => {
    if (!canTakeMainAction || isSubmitting) return;
    pendingOriginRectsRef.current = collectAnimationRects();
    setIsSubmitting(true);
    setActionMode(null);
    moveAPI.mainAction(action);
    if (submitTimerRef.current !== null) window.clearTimeout(submitTimerRef.current);
    submitTimerRef.current = window.setTimeout(() => setIsSubmitting(false), 900);
  };

  const toggleMode = (mode: Exclude<CardActionMode, null>) => {
    const reserveAllowed = mode !== 'reserve' || (localPlayer?.reservedCards.length ?? 3) < 3;
    setActionMode((current) => reduceCardActionMode(current, { type: 'toggle', mode }, canTakeMainAction && !isSubmitting && reserveAllowed));
    setPurchaseTarget(null);
  };

  const modeGuidance = actionMode === 'buy'
    ? t('game.buyModeGuidance')
    : actionMode === 'reserve'
      ? t('game.reserveModeGuidance')
      : t('game.actionModeGuidance');

  const flightLayer = flights.length > 0 && typeof document !== 'undefined'
    ? createPortal(
        <div className="card-flight-layer" aria-hidden="true">
          {flights.map((flight) => (
            <div
              key={flight.id}
              className={`card-flight flight-${flight.kind}`}
              style={flightStyle(flight)}
            >
              {flight.card
                ? <DevelopmentCardView card={flight.card} variant="flight" />
                : <span className="card-back-label">{flight.label}</span>}
            </div>
          ))}
        </div>,
        document.body,
      )
    : null;

  return (
    <div className={`game-shell${isLocalTurn && !isSpectator && !G.result ? ' local-turn-active' : ''}`}>
      <div className="turn-edge-highlight" aria-hidden="true" />
      {turnNoticeVisible && (
        <div key={turnNotice} className="your-turn-popup" aria-hidden="true">
          {t('game.yourTurn')}
        </div>
      )}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {turnNoticeVisible ? t('game.yourTurnAnnouncement') : ''}
      </div>

      <header className="game-header">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true">◆</div>
          <div>
            <strong>{t('common.appName')}</strong>
            <span>{t('common.match', { id: matchID })}</span>
          </div>
        </div>
        <div className="turn-banner">
          <span className={`connection-dot${isConnected ? ' online' : ''}`} />
          <div>
            <span>{isSpectator ? t('game.spectating') : isLocalTurn ? t('game.yourTurn') : t('game.currentPlayer')}</span>
            <strong>{playerName(playerNames, ctx.currentPlayer, t)}</strong>
          </div>
          {G.finalRound && <span className="final-badge">{t('game.finalRound')}</span>}
        </div>
        <div className="header-actions">
          <SpectatorPopover room={room} />
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
          <button type="button" className="button button-quiet button-small" onClick={isSpectator ? onReturnToLobby : onLeaveMatch}>
            {t('game.returnLobby')}
          </button>
          {accountMenu}
        </div>
      </header>

      <main className={`game-workspace${isSpectator ? ' spectator-workspace' : ''}`}>
        <section className={`upper-play-area${isSpectator ? ' spectator-play-area' : ''}`}>
          {!isSpectator && <aside className="reserved-column">
            <section className="action-card reserved-section">
              <div className="section-heading compact-heading">
                <div>
                  <span className="eyebrow">{t('game.privateHand')}</span>
                  <h2>{t('game.yourReserved')}</h2>
                </div>
                <span className="count-badge">{localPlayer?.reservedCards.length ?? 0}/3</span>
              </div>
              {localPlayer && localPlayer.reservedCards.length > 0 ? (
                <div className="reserved-list">
                  {localPlayer.reservedCards.map((reserved, index) => {
                    const card = reserved.cardId ? requireCard(reserved.cardId) : null;
                    if (!card) return <div className="hidden-reserved" key={`hidden-${index}`}>{t('game.hiddenCard', { tier: reserved.tier })}</div>;
                    const canBuy = actionMode === 'buy' && canTakeMainAction && !isSubmitting &&
                      analyzePayment(G, localID!, card).errors.length === 0;
                    return (
                      <DevelopmentCardView
                        key={card.id}
                        card={card}
                        variant="reserved-detail"
                        mode={actionMode === 'buy' ? 'buy' : null}
                        selectable={canBuy}
                        animationKey={`reserved-detail-${localID}-${card.id}`}
                        onSelect={() => setPurchaseTarget({ card, location: { source: 'reserved', cardId: card.id } })}
                      />
                    );
                  })}
                </div>
              ) : (
                <p className="empty-copy reserved-empty-state">{t('game.reserveHelp')}</p>
              )}
            </section>
          </aside>}

          <div className="table-column">
            <section className="nobles-panel">
              <div className="nobles-label">
                <span className="eyebrow">{t('game.visits')}</span>
                <h2>{t('game.availableNobles')}</h2>
              </div>
              <div className="nobles-row">
                {G.availableNobleIds.map((nobleID) => <NobleTile key={nobleID} nobleID={nobleID} />)}
                {G.availableNobleIds.length === 0 && <p className="empty-copy">{t('game.noNobles')}</p>}
              </div>
              <span className="subtle-note">{t('game.oneNoble')}</span>
            </section>
            <div className="markets">
              {([3, 2, 1] as const).map((tier) => (
                <MarketTier
                  key={tier}
                  tier={tier}
                  state={G}
                  playerID={localID}
                  mode={actionMode}
                  interactive={canTakeMainAction && !isSubmitting}
                  replacingSlot={replacingSlot}
                  onBuy={(card, location) => setPurchaseTarget({ card, location })}
                  onReserve={(selectedTier, cardID) => sendMainAction({ type: 'reserveMarket', tier: selectedTier, cardId: cardID })}
                  onBlindReserve={(selectedTier) => sendMainAction({ type: 'reserveDeck', tier: selectedTier })}
                />
              ))}
            </div>
          </div>

          <aside className="actions-column right-column">
            {isSpectator && (
              <section className="action-card spectator-status-card">
                <div className="section-heading compact-heading">
                  <div><span className="eyebrow">{t('game.liveView')}</span><h2>{t('game.spectating')}</h2></div>
                  <span aria-hidden="true">👁</span>
                </div>
                <p className="empty-copy">{t('game.spectatorHelp')}</p>
              </section>
            )}
            {!isSpectator && (
              <TokenTakePanel
                state={G}
                playerID={localID}
                currentPlayerID={ctx.currentPlayer}
                enabled={canTakeMainAction && !isSubmitting && actionMode === null}
                blockedGuidance={actionMode ? modeGuidance : undefined}
                resetKey={actionMode ?? 'none'}
                onAction={sendMainAction}
              />
            )}
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
                    {formatActionLog(entry, t, playerNames)}
                  </li>
                ))}
                {G.actionLog.length === 0 && <li className="empty-copy">{t('game.firstMove')}</li>}
              </ol>
            </section>
          </aside>
        </section>

        {!isSpectator && <section className="card-action-toolbar" aria-label={t('game.cardActions')}>
          <div className="toolbar-buttons">
            <button
              type="button"
              className={`button button-primary${actionMode === 'buy' ? ' mode-active' : ''}`}
              disabled={!canTakeMainAction || isSubmitting}
              aria-pressed={actionMode === 'buy'}
              onClick={() => toggleMode('buy')}
            >
              {t('game.buy')}
            </button>
            <button
              type="button"
              className={`button button-ghost${actionMode === 'reserve' ? ' mode-active' : ''}`}
              disabled={!canTakeMainAction || isSubmitting || (localPlayer?.reservedCards.length ?? 3) >= 3}
              aria-pressed={actionMode === 'reserve'}
              onClick={() => toggleMode('reserve')}
            >
              {t('game.reserve')}
            </button>
          </div>
          <p>{modeGuidance}</p>
        </section>}

        <section className="players-strip-section">
          <div className="section-heading player-strip-heading">
            <div>
              <span className="eyebrow">{t('game.table')}</span>
              <h2>{t('game.players')}</h2>
            </div>
          </div>
          <div className="player-strip">
            {G.playerOrder.map((id) => (
              <PlayerSummary
                key={id}
                state={G}
                id={id}
                name={playerName(playerNames, id, t)}
                isCurrent={ctx.currentPlayer === id}
                isLocal={localID === id}
                avatarUrl={playerAvatars[id] ?? ''}
                connectionStatus={playerConnections[id] ?? 'reconnecting'}
                difficulty={playerDifficulties?.[id]}
              />
            ))}
          </div>
        </section>
      </main>

      {flightLayer}

      {purchaseTarget && localID && (
        <PaymentPanel
          state={G}
          playerID={localID}
          card={purchaseTarget.card}
          location={purchaseTarget.location}
          onCancel={() => {
            setPurchaseTarget(null);
            setActionMode(null);
          }}
          onConfirm={(location, payment) => {
            sendMainAction({ type: 'purchase', location, payment });
            setPurchaseTarget(null);
          }}
        />
      )}

      {G.pending?.type === 'discard' && localID === G.pending.playerID && discardUi.returned && !discardUi.hidden && (
        <DiscardPanel
          state={G}
          playerID={localID}
          currentPlayerID={ctx.currentPlayer}
          returned={discardUi.returned}
          onReturnedChange={(returned) => setDiscardUi((current) => reduceDiscardUi(current, { type: 'change', returned }))}
          onHide={() => {
            setDiscardUi((current) => reduceDiscardUi(current, { type: 'hide' }));
            window.requestAnimationFrame(() => resumeDiscardRef.current?.focus());
          }}
          onConfirm={(tokens) => {
            setDiscardUi((current) => reduceDiscardUi(current, { type: 'show' }));
            moveAPI.discardTokens(tokens);
          }}
        />
      )}

      {G.pending?.type === 'discard' && localID === G.pending.playerID && discardUi.hidden && (
        <button
          ref={resumeDiscardRef}
          type="button"
          className="resume-discard-button"
          onClick={() => setDiscardUi((current) => reduceDiscardUi(current, { type: 'show' }))}
        >
          {t('game.continueReturning', { count: G.pending.count })}
        </button>
      )}

      {G.pending?.type === 'noble' && localID === G.pending.playerID && (
        <NoblePanel nobleIDs={G.pending.eligibleNobleIds} onChoose={(nobleID) => moveAPI.chooseNoble(nobleID)} />
      )}

      <GameOverPanel
        state={G}
        names={playerNames}
        room={room}
        onPlayAgain={onPlayAgain}
        onWatchRematch={onWatchRematch}
        onReturn={onReturnToLobby}
      />
    </div>
  );
}
