/**
 * Entity-based observation/action encoder (guide §3). Fixed-size padded
 * tensors with explicit masks; acting player is always relative index 0.
 * The Python training environment mirrors this exactly; the golden-vector
 * test (scripts/ai/neural/golden.ts -> ai_bot/neural/tests/golden_test.py)
 * proves parity.
 */

import { getCard, getNoble } from '../../data/gameData.js';
import type { AIObservation } from '../observation.js';
import type {
  DevelopmentCard,
  MainAction,
  TokenCounts,
} from '../../types/game.js';

export const MAX_PLAYERS = 4;
export const MAX_MARKET_CARDS = 12;
export const MAX_RESERVED_CARDS = 12;
export const MAX_NOBLES = 5;
export const MAX_ACTIONS = 64;

export const OBS_DIM = 462;
export const ACTION_DIM = 43;

const NORMAL = ['white', 'blue', 'green', 'red', 'black'] as const;
const ALL_TOKENS = [...NORMAL, 'gold'] as const;

const relSeat = (
  playerOrder: string[],
  selfID: string,
  targetID: string,
): number => {
  const selfIndex = playerOrder.indexOf(selfID);
  const targetIndex = playerOrder.indexOf(targetID);
  if (selfIndex < 0 || targetIndex < 0) return 0;
  return (targetIndex - selfIndex + playerOrder.length) % playerOrder.length;
};

const cardVector = (
  card: DevelopmentCard | undefined,
  present: number,
): number[] => [
  present,
  (card?.tier ?? 0) / 3,
  (card?.points ?? 0) / 5,
  ...NORMAL.map((color) => (card?.cost[color] ?? 0) / 7),
  ...NORMAL.map((color) => (card?.bonus === color ? 1 : 0)),
];

/** 462-dim observation vector. */
export const encodeObservation = (observation: AIObservation): Float32Array => {
  const out = new Float32Array(OBS_DIM);
  let cursor = 0;
  const push = (...values: number[]): void => {
    for (const value of values) out[cursor++] = value;
  };
  const selfID = observation.playerID;
  const playerOrder = observation.playerOrder;
  // Acting-player-relative order: self is always seat 0 (guide §3.1).
  const relativeOrder = [
    selfID,
    ...playerOrder.filter((playerID) => playerID !== selfID),
  ];

  // Global (15)
  push(...ALL_TOKENS.map((color) => observation.bank[color] / 7));
  push(
    observation.deckCounts[1] / 40,
    observation.deckCounts[2] / 40,
    observation.deckCounts[3] / 40,
  );
  push(
    observation.completedTurns / 200,
    observation.finalRound ? 1 : 0,
    observation.playerOrder.length / 4,
  );
  push(
    observation.pending === null ? 1 : 0,
    observation.pending?.type === 'discard' ? 1 : 0,
    observation.pending?.type === 'noble' ? 1 : 0,
  );

  // Players (4 x 16, fixed width regardless of presence)
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    const playerID = relativeOrder[seat];
    const player = observation.players[playerID];
    if (!player) {
      push(...new Array(16).fill(0));
      continue;
    }
    push(...ALL_TOKENS.map((color) => player.tokens[color] / 10));
    const bonuses = NORMAL.map((color) =>
      player.purchasedCardIds.reduce(
        (sum, cardID) => sum + (getCard(cardID)?.bonus === color ? 1 : 0),
        0,
      ),
    );
    push(...bonuses.map((count) => count / 10));
    const score = player.purchasedCardIds.reduce(
      (sum, cardID) => sum + (getCard(cardID)?.points ?? 0),
      0,
    ) + player.nobleIds.reduce(
      (sum, nobleID) => sum + (getNoble(nobleID)?.points ?? 0),
      0,
    );
    push(
      score / 15,
      player.purchasedCardIds.length / 25,
      player.reservedCards.length / 3,
      player.nobleIds.length / 5,
      playerID === selfID ? 1 : 0,
    );
  }

  // Market cards (12 x 13)
  for (let tier = 1; tier <= 3; tier += 1) {
    for (const cardID of observation.market[tier as 1 | 2 | 3]) {
      push(...cardVector(cardID ? getCard(cardID) : undefined, cardID ? 1 : 0));
    }
  }

  // Reserved cards (12 x 16, fixed width regardless of presence)
  for (let seat = 0; seat < MAX_PLAYERS; seat += 1) {
    const playerID = relativeOrder[seat];
    const player = observation.players[playerID];
    for (let index = 0; index < 3; index += 1) {
      const reserved = player?.reservedCards[index];
      if (!reserved) {
        push(...new Array(16).fill(0));
        continue;
      }
      const known = reserved.cardId !== null;
      const card = known ? getCard(reserved.cardId ?? '') : undefined;
      push(
        1,
        relSeat(playerOrder, selfID, playerID) / MAX_PLAYERS,
        reserved.tier / 3,
        reserved.source === 'market' ? 1 : 0,
        known ? 1 : 0,
        (card?.points ?? 0) / 5,
        ...NORMAL.map((color) => (card?.cost[color] ?? 0) / 7),
        ...NORMAL.map((color) => (card?.bonus === color ? 1 : 0)),
      );
    }
  }

  // Nobles (5 x 7)
  for (let index = 0; index < MAX_NOBLES; index += 1) {
    const nobleID = observation.availableNobleIds[index];
    const noble = nobleID ? getNoble(nobleID) : undefined;
  push(
    nobleID ? 1 : 0,
    (noble?.points ?? 0) / 3,
    ...NORMAL.map((color) => (noble?.requirement[color] ?? 0) / 7),
  );
  }
  return out;
};

const actionTypeIndex = (
  action: MainAction | { type: 'discardTokens' | 'chooseNoble' },
): number => {
  switch (action.type) {
    case 'takeDifferent':
      return 0;
    case 'takeSame':
      return 1;
    case 'reserveMarket':
      return 2;
    case 'reserveDeck':
      return 3;
    case 'purchase':
      return 4;
    case 'pass':
      return 5;
    case 'discardTokens':
      return 6;
    case 'chooseNoble':
      return 7;
  }
};

const targetCardFor = (
  observation: AIObservation,
  action: MainAction,
): { card: DevelopmentCard | undefined; known: boolean } => {
  if (action.type === 'purchase') {
    if (action.location.source === 'market') {
      return { card: getCard(action.location.cardId), known: true };
    }
    const reserved = observation.players[observation.playerID]?.reservedCards.find(
      (entry) => entry.cardId === action.location.cardId,
    );
    return { card: getCard(action.location.cardId), known: true };
  }
  if (action.type === 'reserveMarket') {
    return { card: getCard(action.cardId), known: true };
  }
  return { card: undefined, known: false };
};

/** 43-dim action vector. */
export const encodeAction = (
  action: MainAction | { type: 'discardTokens'; tokens: TokenCounts } | {
    type: 'chooseNoble';
    nobleID: string;
  },
  observation: AIObservation,
): Float32Array => {
  const out = new Float32Array(ACTION_DIM);
  let cursor = 0;
  const push = (...values: number[]): void => {
    for (const value of values) out[cursor++] = value;
  };
  const typeIndex = actionTypeIndex(action);
  for (let index = 0; index < 8; index += 1) {
    push(typeIndex === index ? 1 : 0);
  }
  const phase =
    action.type === 'discardTokens'
      ? 1
      : action.type === 'chooseNoble'
        ? 2
        : 0;
  push(phase === 0 ? 1 : 0, phase === 1 ? 1 : 0, phase === 2 ? 1 : 0);
  let tier = 0;
  let tokenDelta = [0, 0, 0, 0, 0, 0];
  let payment = [0, 0, 0, 0, 0, 0];
  let target: { card: DevelopmentCard | undefined; known: boolean } = {
    card: undefined,
    known: false,
  };
  let noble = { points: 0, requirement: [0, 0, 0, 0, 0] };
  if (action.type === 'takeDifferent') {
    tokenDelta = NORMAL.map((color) => (action.colors.includes(color) ? 1 : 0));
  } else if (action.type === 'takeSame') {
    tokenDelta = NORMAL.map((color) => (color === action.color ? 2 : 0));
  } else if (action.type === 'reserveMarket') {
    tier = action.tier;
    target = targetCardFor(observation, action);
  } else if (action.type === 'reserveDeck') {
    tier = action.tier;
  } else if (action.type === 'purchase') {
    target = targetCardFor(observation, action);
    if (action.location.source === 'market') tier = action.location.tier;
    payment = ALL_TOKENS.map((color) => action.payment[color]);
  } else if (action.type === 'discardTokens') {
    payment = ALL_TOKENS.map((color) => action.tokens[color]);
  } else if (action.type === 'chooseNoble') {
    const nobleData = getNoble(action.nobleID);
    noble = {
      points: nobleData?.points ?? 0,
      requirement: NORMAL.map((color) => nobleData?.requirement[color] ?? 0),
    };
  }
  push(
    tier === 1 ? 1 : 0,
    tier === 2 ? 1 : 0,
    tier === 3 ? 1 : 0,
  );
  push(...tokenDelta.map((value) => value / 3));
  push(...payment.map((value) => value / 7));
  push(
    (target.card?.points ?? 0) / 5,
    ...NORMAL.map((color) => (target.card?.cost[color] ?? 0) / 7),
    ...NORMAL.map((color) => (target.card?.bonus === color ? 1 : 0)),
  );
  push(
    noble.points / 3,
    ...noble.requirement.map((value) => value / 7),
  );
  return out;
};

/** Convenience: encode a legal-action move from the AI candidate shape. */
export const encodeAIMove = (
  move: { move: 'mainAction' | 'discardTokens' | 'chooseNoble'; args: unknown[] },
  observation: AIObservation,
): Float32Array => {
  const [argument] = move.args;
  if (move.move === 'mainAction') {
    return encodeAction(argument as MainAction, observation);
  }
  if (move.move === 'discardTokens') {
    return encodeAction(
      { type: 'discardTokens', tokens: argument as TokenCounts },
      observation,
    );
  }
  return encodeAction(
    { type: 'chooseNoble', nobleID: argument as string },
    observation,
  );
};
