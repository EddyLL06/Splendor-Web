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
  const paymentErrors =
    playerID === null
      ? [{ message: 'Join a player seat to buy cards.' }]
      : analyzePayment(state, playerID, card).errors;
  const canBuy = interactive && paymentErrors.length === 0;

  return (
    <article className={`development-card bonus-${card.bonus}`}>
      <div className="card-topline">
        <span className="card-tier">Tier {card.tier}</span>
        <span className="card-points" aria-label={`${card.points} prestige`}>
          {card.points} <span aria-hidden="true">◆</span>
        </span>
      </div>
      <div className="card-bonus">
        <TokenBadge color={card.bonus} count={1} />
        <span>permanent bonus</span>
      </div>
      <div className="card-cost" aria-label="Card cost">
        {NORMAL_COLORS.filter((color) => card.cost[color] > 0).map((color) => (
          <TokenBadge
            key={color}
            color={color}
            count={card.cost[color]}
            compact
          />
        ))}
        {NORMAL_COLORS.every((color) => card.cost[color] === 0) && (
          <span className="free-label">Free</span>
        )}
      </div>
      <div className="card-actions">
        <button
          type="button"
          className="button button-primary button-small"
          disabled={!canBuy}
          title={canBuy ? 'Buy this card' : paymentErrors[0]?.message}
          onClick={() => onBuy(card, location)}
        >
          Buy
        </button>
        {location.source === 'market' && onReserve && (
          <button
            type="button"
            className="button button-ghost button-small"
            disabled={!interactive || !canReserve}
            title={
              canReserve
                ? 'Reserve this visible card'
                : 'You cannot reserve another card now.'
            }
            onClick={() => onReserve(card)}
          >
            Reserve
          </button>
        )}
      </div>
    </article>
  );
}
