import { useTranslation } from 'react-i18next';

import { NORMAL_COLORS } from '../../shared/constants/colors.js';
import type { DevelopmentCard } from '../../shared/types/game.js';
import type { CardActionMode } from '../gameUiState.js';
import { TokenBadge } from './TokenBadge.js';

export type DevelopmentCardVariant =
  | 'market'
  | 'reserved-detail'
  | 'preview'
  | 'flight';

interface DevelopmentCardViewProps {
  card: DevelopmentCard;
  mode?: CardActionMode;
  selectable?: boolean;
  onSelect?: () => void;
  animationKey?: string;
  replacing?: boolean;
  variant?: DevelopmentCardVariant;
}

export function DevelopmentCardView({
  card,
  mode = null,
  selectable = false,
  onSelect,
  animationKey,
  replacing = false,
  variant = 'market',
}: DevelopmentCardViewProps) {
  const { t } = useTranslation();
  const className = `development-card development-card-${variant} bonus-${card.bonus}${
    mode ? ` card-mode-${mode}` : ' card-informational'
  }${selectable ? ' card-selectable' : ''}${mode && !selectable ? ' card-unavailable' : ''}${
    replacing ? ' card-replacing' : ''
  }`;
  const content = (
    <>
      <div className="card-topline">
        <span className="card-identity">
          <span className="card-tier">{t('game.tier', { tier: card.tier })}</span>
          {variant !== 'market' && <strong className="card-id">{card.id}</strong>}
        </span>
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
          <TokenBadge key={color} color={color} count={card.cost[color]} compact />
        ))}
        {NORMAL_COLORS.every((color) => card.cost[color] === 0) && (
          <span className="free-label">{t('game.free')}</span>
        )}
      </div>
      {mode && (
        <span className="card-mode-label">
          {selectable
            ? t(mode === 'buy' ? 'game.selectToBuy' : 'game.selectToReserve')
            : t('game.cardUnavailable')}
        </span>
      )}
    </>
  );

  if (!mode) {
    return (
      <article className={className} data-animation-key={animationKey}>
        {content}
      </article>
    );
  }

  return (
    <button
      type="button"
      className={className}
      disabled={!selectable}
      onClick={onSelect}
      data-animation-key={animationKey}
      aria-label={t(mode === 'buy' ? 'game.buyCardNamed' : 'game.reserveCardNamed', {
        id: card.id,
      })}
    >
      {content}
    </button>
  );
}
