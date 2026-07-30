import {
  DEVELOPMENT_CARDS,
  NOBLES,
} from './generated-game-data.js';
import type {
  DevelopmentCard,
  Noble,
  Tier,
} from '../types/game.js';

export { DEVELOPMENT_CARDS, NOBLES };

const cardsByID = new Map<string, DevelopmentCard>(
  DEVELOPMENT_CARDS.map((card) => [card.id, card]),
);
const noblesByID = new Map<string, Noble>(
  NOBLES.map((noble) => [noble.id, noble]),
);

export const getCard = (cardID: string): DevelopmentCard | undefined =>
  cardsByID.get(cardID);

export const requireCard = (cardID: string): DevelopmentCard => {
  const card = getCard(cardID);
  if (!card) {
    throw new Error(`Unknown development card "${cardID}".`);
  }
  return card;
};

export const getNoble = (nobleID: string): Noble | undefined =>
  noblesByID.get(nobleID);

export const requireNoble = (nobleID: string): Noble => {
  const noble = getNoble(nobleID);
  if (!noble) {
    throw new Error(`Unknown noble "${nobleID}".`);
  }
  return noble;
};

export const cardsForTier = (tier: Tier): DevelopmentCard[] =>
  DEVELOPMENT_CARDS.filter((card) => card.tier === tier);
