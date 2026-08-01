import { useTranslation } from 'react-i18next';

import { NORMAL_COLORS } from '../../shared/constants/colors.js';
import { analyzePayment } from '../../shared/rules/selectors.js';
import type {
  CardLocation,
  DevelopmentCard,
  PlayerID,
  SplendorState,
} from '../../shared/types/game.js';
import { TokenBadge } from './TokenBadge.js';

interface DevelopmentCardViewProps {
  card: DevelopmentCard;
  state: SplendorState;
  playerID: PlayerID | null;
  location: CardLocation;
  interactive: boolean;
  canReserve?: boolean;
  onBuy: (card: DevelopmentCard, location: CardLocation) => void;
  onReserve?: (card: DevelopmentCard) => void;
}

export function DevelopmentCardView({
  card,
  state,
  playerID,
  location,
  interactive,
  canReserve = false,
  onBuy,
  onReserve,
}: DevelopmentCardViewProps) {
  const { t } = useTranslation();
  const paymentErrors =
    playerID === null
      ? [{ message: t('game.joinToBuy') }]
      : analyzePayment(state, playerID, card).errors;
  const canBuy = interactive && paymentErrors.length === 0;

  return (
    <article className={`development-card bonus-${card.bonus}`}>
      <div className="card-topline">
        <span className="card-tier">{t('game.tier', { tier: card.tier })}</span>
        <span className="card-points" aria-label={t('game.standingPrestige', { count: card.points })}>
          {card.points} <span aria-hidden="true">◆</span>
        </span>
      </div>
      <div className="card-bonus">
        <TokenBadge color={card.bonus} count={1} />
        <span>{t('game.permanentBonus')}</span>
      </div>
      <div className="card-cost" aria-label={t('game.cardCost')}>
        {NORMAL_COLORS.filter((color) => card.cost[color] > 0).map((color) => (
          <TokenBadge
            key={color}
            color={color}
            count={card.cost[color]}
            compact
          />
        ))}
        {NORMAL_COLORS.every((color) => card.cost[color] === 0) && (
          <span className="free-label">{t('game.free')}</span>
        )}
      </div>
      <div className="card-actions">
        <button
          type="button"
          className="button button-primary button-small"
          disabled={!canBuy}
          title={canBuy ? t('game.buyCard') : t('errors.INVALID_INPUT')}
          onClick={() => onBuy(card, location)}
        >
          {t('game.buy')}
        </button>
        {location.source === 'market' && onReserve && (
          <button
            type="button"
            className="button button-ghost button-small"
            disabled={!interactive || !canReserve}
            title={
              canReserve
                ? t('game.reserveVisible')
                : t('game.cannotReserve')
            }
            onClick={() => onReserve(card)}
          >
            {t('game.reserve')}
          </button>
        )}
      </div>
    </article>
  );
}
