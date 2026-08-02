/**
 * Three-phase legal action enumeration (DEVELOPMENT_GUIDE.md §6). All main
 * action candidates are generated from public/own-visible data; tests assert
 * that every candidate is accepted by the authoritative `applyMainAction`.
 */

import { NORMAL_COLORS, TOKEN_COLORS } from '../constants/colors.js';
import { analyzePayment, findPurchasableCard } from '../rules/selectors.js';
import { applyMainAction, hasLegalMainAction } from '../rules/engine.js';
import type {
  CardLocation,
  MainAction,
  PlayerID,
  SplendorState,
  TokenColor,
  TokenCounts,
} from '../types/game.js';
import type { BotMove } from './types.js';

export interface AIActionCandidate {
  actionKey: string;
  move: BotMove;
}

export const MAX_DISCARD_CANDIDATES = 256;

const colorCombinations = (
  colors: readonly TokenColor[],
  size: number,
): TokenColor[][] => {
  const results: TokenColor[][] = [];
  const current: TokenColor[] = [];
  const visit = (start: number): void => {
    if (current.length === size) {
      results.push([...current]);
      return;
    }
    for (let index = start; index < colors.length; index += 1) {
      current.push(colors[index]);
      visit(index + 1);
      current.pop();
    }
  };
  visit(0);
  return results;
};

const emptyDiscard = (): TokenCounts => ({
  white: 0,
  blue: 0,
  green: 0,
  red: 0,
  black: 0,
  gold: 0,
});

const buildDiscards = (
  owned: TokenCounts,
  count: number,
  colorIndex: number,
  current: TokenCounts,
  output: TokenCounts[],
  budget: { remaining: number },
): void => {
  if (budget.remaining <= 0) return;
  if (colorIndex === TOKEN_COLORS.length) {
    if (count === 0) {
      output.push({ ...current });
      budget.remaining -= 1;
    }
    return;
  }
  const color = TOKEN_COLORS[colorIndex];
  const max = Math.min(owned[color], count);
  for (let amount = 0; amount <= max; amount += 1) {
    current[color] = amount;
    buildDiscards(owned, count - amount, colorIndex + 1, current, output, budget);
    if (budget.remaining <= 0) return;
  }
  current[color] = 0;
};

export const enumerateDiscardCandidates = (
  state: SplendorState,
  playerID: PlayerID,
  maxCandidates = MAX_DISCARD_CANDIDATES,
): AIActionCandidate[] => {
  if (state.pending?.type !== 'discard' || state.pending.playerID !== playerID) {
    return [];
  }
  const owned = state.players[playerID]?.tokens;
  if (!owned) return [];
  const candidates: TokenCounts[] = [];
  buildDiscards(
    owned,
    state.pending.count,
    0,
    emptyDiscard(),
    candidates,
    { remaining: maxCandidates },
  );
  return candidates.map((counts, index) => ({
    actionKey: `discard:${index}`,
    move: { move: 'discardTokens', args: [counts] },
  }));
};

export const enumerateNobleCandidates = (
  state: SplendorState,
  playerID: PlayerID,
): AIActionCandidate[] => {
  if (state.pending?.type !== 'noble' || state.pending.playerID !== playerID) {
    return [];
  }
  return state.pending.eligibleNobleIds.map((nobleID) => ({
    actionKey: `noble:${nobleID}`,
    move: { move: 'chooseNoble', args: [nobleID] },
  }));
};

export const enumerateMainActions = (
  state: SplendorState,
  playerID: PlayerID,
  currentPlayer: PlayerID,
  validate = false,
): AIActionCandidate[] => {
  if (state.pending !== null) return [];
  const player = state.players[playerID];
  if (!player || playerID !== currentPlayer) return [];

  const candidates: AIActionCandidate[] = [];
  const reserveLimit = player.reservedCards.length < 3;

  const availableColors = NORMAL_COLORS.filter(
    (color) => state.bank[color] > 0,
  );
  if (availableColors.length === 2) {
    candidates.push({
      actionKey: `takeDifferent:${availableColors.join(',')}`,
      move: {
        move: 'mainAction',
        args: [{ type: 'takeDifferent', colors: [...availableColors] }],
      },
    });
  } else {
    for (const colors of colorCombinations(NORMAL_COLORS, 3)) {
      if (colors.every((color) => state.bank[color] > 0)) {
        candidates.push({
          actionKey: `takeDifferent:${colors.join(',')}`,
          move: { move: 'mainAction', args: [{ type: 'takeDifferent', colors }] },
        });
      }
    }
  }

  for (const color of NORMAL_COLORS) {
    if (state.bank[color] >= 4) {
      candidates.push({
        actionKey: `takeSame:${color}`,
        move: { move: 'mainAction', args: [{ type: 'takeSame', color }] },
      });
    }
  }

  if (reserveLimit) {
    for (const tier of [1, 2, 3] as const) {
      for (const cardID of state.market[tier]) {
        if (cardID !== null) {
          candidates.push({
            actionKey: `reserveMarket:${tier}:${cardID}`,
            move: {
              move: 'mainAction',
              args: [{ type: 'reserveMarket', tier, cardId: cardID }],
            },
          });
        }
      }
      if (state.decks[tier].length > 0) {
        candidates.push({
          actionKey: `reserveDeck:${tier}`,
          move: { move: 'mainAction', args: [{ type: 'reserveDeck', tier }] },
        });
      }
    }
  }

  for (const tier of [1, 2, 3] as const) {
    for (const cardID of state.market[tier]) {
      if (cardID === null) continue;
      const location: CardLocation = {
        source: 'market',
        tier,
        cardId: cardID,
      };
      const action = purchaseAction(playerID, state, location);
      if (action) {
        candidates.push({
          actionKey: `purchase:market:${tier}:${cardID}`,
          move: { move: 'mainAction', args: [action] },
        });
      }
    }
  }
  for (const reserved of player.reservedCards) {
    if (reserved.cardId === null) continue;
    const location: CardLocation = {
      source: 'reserved',
      cardId: reserved.cardId,
    };
    const action = purchaseAction(playerID, state, location);
    if (action) {
      candidates.push({
        actionKey: `purchase:reserved:${reserved.cardId}`,
        move: { move: 'mainAction', args: [action] },
      });
    }
  }

  if (candidates.length === 0 && !hasLegalMainAction(state, playerID)) {
    candidates.push({
      actionKey: 'pass:stall-rescue',
      move: { move: 'mainAction', args: [{ type: 'pass' }] },
    });
  }

  if (validate) {
    return candidates.filter((candidate) => {
      const action = candidate.move.args[0] as MainAction;
      const result = applyMainAction(
        JSON.parse(JSON.stringify(state)) as SplendorState,
        playerID,
        currentPlayer,
        action,
      );
      return result.ok;
    });
  }
  return candidates;
};

const purchaseAction = (
  playerID: PlayerID,
  state: SplendorState,
  location: CardLocation,
): MainAction | null => {
  const cardResult = findPurchasableCard(state, playerID, location);
  if (!cardResult.ok) return null;
  const analysis = analyzePayment(state, playerID, cardResult.value);
  if (analysis.errors.length > 0) return null;
  return {
    type: 'purchase',
    location,
    payment: analysis.suggestedPayment,
  };
};

export const enumerateLegalActions = (
  state: SplendorState,
  playerID: PlayerID,
  currentPlayer: PlayerID,
): AIActionCandidate[] => {
  if (state.pending?.type === 'discard') {
    return enumerateDiscardCandidates(state, playerID);
  }
  if (state.pending?.type === 'noble') {
    return enumerateNobleCandidates(state, playerID);
  }
  return enumerateMainActions(state, playerID, currentPlayer);
};
