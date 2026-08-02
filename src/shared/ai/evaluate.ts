/**
 * Cheap, explainable heuristic evaluation for the round-1 greedy baseline
 * (DEVELOPMENT_GUIDE.md §8). Every candidate is scored by simulating it with
 * the authoritative rules and evaluating the resulting state from the
 * acting player's perspective. No hidden information is used.
 */

import { getBonuses, getScore, totalTokens } from '../rules/selectors.js';
import { getCard, getNoble } from '../data/gameData.js';
import type {
  DevelopmentCard,
  MainAction,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../types/game.js';
import { effectiveCostForCard } from '../rules/selectors.js';
import type { AIActionCandidate } from './legal-actions.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from './simulate.js';
import type { BoardContextView } from './types.js';

const INVALID_SCORE = -1_000_000_000;

const averageNobleCloseness = (state: SplendorState, playerID: PlayerID): number => {
  const bonuses = getBonuses(state, playerID);
  const scores: number[] = [];
  for (const nobleID of state.availableNobleIds) {
    const noble = getNoble(nobleID);
    if (!noble) continue;
    let achieved = 0;
    let required = 0;
    for (const [color, count] of Object.entries(noble.requirement) as [
      'white' | 'blue' | 'green' | 'red' | 'black',
      number,
    ][]) {
      required += count;
      achieved += Math.min(bonuses[color], count);
    }
    if (required > 0) scores.push(achieved / required);
  }
  return scores.length === 0 ? 0 : scores.reduce((sum, value) => sum + value, 0) / scores.length;
};

/**
 * State value from `playerID`'s perspective. Positive features are capped so
 * early engine building is not drowned out by raw score.
 */
export const evaluateState = (
  state: SplendorState,
  playerID: PlayerID,
): number => {
  const player = state.players[playerID];
  if (!player) return INVALID_SCORE;

  if (state.result) {
    return state.result.winners.includes(playerID) ? 1_000_000 : -1_000_000;
  }

  let value = 0;
  value += getScore(state, playerID) * 100;
  const bonuses = getBonuses(state, playerID);
  const bonusCount = Object.values(bonuses).reduce((sum, count) => sum + count, 0);
  value += Math.min(bonusCount, 20) * 12;
  value += averageNobleCloseness(state, playerID) * 30;

  const tokens = totalTokens(player.tokens);
  value += tokens * 2;
  value += player.tokens.gold * 4;
  value += Math.min(player.reservedCards.length, 3) * -3;

  if (state.pending?.type === 'discard' && state.pending.playerID === playerID) {
    value -= state.pending.count * 20;
  }
  return value;
};

const scoreMainAction = (
  state: SplendorState,
  playerID: PlayerID,
  ctx: BoardContextView,
  action: MainAction,
): number => {
  const sim = createSimulation(
    JSON.parse(JSON.stringify(state)) as SplendorState,
    ctx,
  );
  const result = applySimulationMainAction(sim, playerID, action);
  if (!result.ok) return INVALID_SCORE;
  let value = evaluateState(sim.G, playerID);
  const usefulness = tokenUsefulness(state, playerID);
  if (sim.G.pending === null && sim.G.turnReady && sim.G.result === null) {
    value += 5; // cleanly completes the turn
  }
  switch (action.type) {
    case 'purchase':
      value += 10;
      value -= action.payment.gold * 5;
      break;
    case 'reserveMarket':
    case 'reserveDeck':
      value += 4;
      break;
    case 'takeSame':
      value += 2;
      value += 2 * usefulness[action.color];
      break;
    case 'takeDifferent':
      value += 3;
      for (const color of action.colors) value += usefulness[color];
      break;
  }
  return value;
};

/**
 * Marginal usefulness of one token of each color: how many market/reserved
 * cards still need that color after discounts. Gold is weighted higher
 * because it is only obtainable through reservations.
 */
const tokenUsefulness = (
  state: SplendorState,
  playerID: PlayerID,
): Record<'white' | 'blue' | 'green' | 'red' | 'black' | 'gold', number> => {
  const values = {
    white: 0,
    blue: 0,
    green: 0,
    red: 0,
    black: 0,
    gold: 2,
  };
  const consider = (card: DevelopmentCard | undefined): void => {
    if (!card) return;
    const effective = effectiveCostForCard(state, playerID, card);
    for (const color of ['white', 'blue', 'green', 'red', 'black'] as const) {
      values[color] += Math.min(effective[color], 2);
    }
  };
  for (const tier of [1, 2, 3] as const) {
    for (const cardID of state.market[tier]) {
      if (cardID !== null) consider(getCard(cardID));
    }
  }
  for (const reserved of state.players[playerID]?.reservedCards ?? []) {
    if (reserved.cardId !== null) consider(getCard(reserved.cardId));
  }
  return values;
};

const scoreDiscard = (
  state: SplendorState,
  playerID: PlayerID,
  ctx: BoardContextView,
  returned: TokenCounts,
): number => {
  const sim = createSimulation(
    JSON.parse(JSON.stringify(state)) as SplendorState,
    ctx,
  );
  const result = applySimulationDiscard(sim, playerID, returned);
  if (!result.ok) return INVALID_SCORE;
  const usefulness = tokenUsefulness(sim.G, playerID);
  const retained = sim.G.players[playerID].tokens;
  let usefulnessScore = 0;
  for (const color of ['white', 'blue', 'green', 'red', 'black', 'gold'] as const) {
    usefulnessScore += retained[color] * usefulness[color];
  }
  return evaluateState(sim.G, playerID) + usefulnessScore;
};

const scoreNoble = (
  state: SplendorState,
  playerID: PlayerID,
  ctx: BoardContextView,
  nobleID: string,
): number => {
  const sim = createSimulation(
    JSON.parse(JSON.stringify(state)) as SplendorState,
    ctx,
  );
  const result = applySimulationNoble(sim, playerID, nobleID);
  if (!result.ok) return INVALID_SCORE;
  const noble = getNoble(nobleID);
  const requirementSum = noble
    ? Object.values(noble.requirement).reduce((sum, count) => sum + count, 0)
    : 0;
  return evaluateState(sim.G, playerID) + requirementSum;
};

/** Score one enumerated candidate by simulating it from the current state. */
export const scoreCandidate = (
  state: SplendorState,
  playerID: PlayerID,
  ctx: BoardContextView,
  candidate: AIActionCandidate,
): number => {
  const [argument] = candidate.move.args;
  if (candidate.move.move === 'mainAction') {
    return scoreMainAction(state, playerID, ctx, argument as MainAction);
  }
  if (candidate.move.move === 'discardTokens') {
    return scoreDiscard(state, playerID, ctx, argument as TokenCounts);
  }
  return scoreNoble(state, playerID, ctx, argument as string);
};
