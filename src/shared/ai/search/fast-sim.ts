/**
 * Fast in-place simulation for the ds-search tree and rollouts.
 *
 * Mirrors `src/shared/rules/engine.ts` exactly but mutates a hand-cloned
 * state instead of JSON-cloning per action, and skips the action log (the
 * search never reads it). Used ONLY inside the search; the final chosen move
 * is still re-validated against the authoritative engine by the policy layer
 * (`validateMove`), and a differential test
 * (`tests/ai/fast-sim.test.ts`) proves state equivalence with the engine
 * across randomized playouts.
 *
 * Determinism: no `Math.random()` anywhere; clone order is fixed.
 */

import { NORMAL_COLORS, TOKEN_COLORS } from '../../constants/colors.js';
import {
  createStandings,
  getEligibleNobleIDs,
  getScore,
  totalTokens,
} from '../../rules/selectors.js';
import type {
  MainAction,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../../types/game.js';
import type { BoardContextView, BotMove } from '../types.js';

// ---------------------------------------------------------------------------
// Hand-written state clone (all mutable fields; the action log is dropped).
// ---------------------------------------------------------------------------

export const cloneStateFast = (state: SplendorState): SplendorState => ({
  bank: { ...state.bank },
  decks: {
    1: [...state.decks[1]],
    2: [...state.decks[2]],
    3: [...state.decks[3]],
  },
  market: {
    1: [...state.market[1]],
    2: [...state.market[2]],
    3: [...state.market[3]],
  } as SplendorState['market'],
  availableNobleIds: [...state.availableNobleIds],
  players: Object.fromEntries(
    Object.entries(state.players).map(([playerID, player]) => [
      playerID,
      {
        tokens: { ...player.tokens },
        purchasedCardIds: [...player.purchasedCardIds],
        reservedCards: player.reservedCards.map((reserved) => ({
          ...reserved,
        })),
        nobleIds: [...player.nobleIds],
      },
    ]),
  ),
  playerOrder: [...state.playerOrder],
  initialFirstPlayer: state.initialFirstPlayer,
  pending:
    state.pending === null
      ? null
      : state.pending.type === 'discard'
        ? {
            type: 'discard',
            playerID: state.pending.playerID,
            count: state.pending.count,
          }
        : {
            type: 'noble',
            playerID: state.pending.playerID,
            eligibleNobleIds: [...state.pending.eligibleNobleIds],
          },
  turnReady: state.turnReady,
  completedTurns: state.completedTurns,
  turnCounts: { ...state.turnCounts },
  finalRound: state.finalRound ? { ...state.finalRound } : null,
  actionLog: [],
  nextLogID: state.nextLogID,
  result: state.result
    ? {
        winners: [...state.result.winners],
        standings: state.result.standings.map((standing) => ({ ...standing })),
      }
    : null,
});

// ---------------------------------------------------------------------------
// Fast simulation state (same shape as src/shared/ai/simulate.ts).
// ---------------------------------------------------------------------------

export interface FastSim {
  G: SplendorState;
  currentPlayer: PlayerID;
  playOrder: PlayerID[];
  playOrderPos: number;
  stateID: number;
}

export const createFastSimulation = (
  G: SplendorState,
  ctx: BoardContextView,
  stateID = 0,
): FastSim => ({
  G,
  currentPlayer: ctx.currentPlayer,
  playOrder: [...ctx.playOrder],
  playOrderPos: ctx.playOrderPos,
  stateID,
});

const advanceIfTurnComplete = (sim: FastSim): void => {
  if (sim.G.result !== null) return;
  if (!sim.G.turnReady) return;
  if (sim.G.pending !== null) return;
  sim.playOrderPos = (sim.playOrderPos + 1) % sim.playOrder.length;
  sim.currentPlayer = sim.playOrder[sim.playOrderPos];
  sim.G.turnReady = false;
  sim.stateID += 1;
};

// ---------------------------------------------------------------------------
// Engine mirror.
// ---------------------------------------------------------------------------

const allPlayersHaveEqualTurns = (state: SplendorState): boolean => {
  const counts = state.playerOrder.map(
    (playerID) => state.turnCounts[playerID],
  );
  return counts.every((count) => count === counts[0]);
};

const finishGame = (state: SplendorState): void => {
  const standings = createStandings(state);
  const leader = standings[0];
  const winners = standings
    .filter(
      (standing) =>
        standing.score === leader.score &&
        standing.purchasedCardCount === leader.purchasedCardCount,
    )
    .map((standing) => standing.playerID);
  state.result = { winners, standings };
};

const completeTurn = (state: SplendorState, playerID: PlayerID): void => {
  state.pending = null;
  state.completedTurns += 1;
  state.turnCounts[playerID] += 1;
  if (!state.finalRound && getScore(state, playerID) >= 15) {
    state.finalRound = {
      triggeredBy: playerID,
      triggeredAtCompletedTurn: state.completedTurns,
    };
  }
  if (state.finalRound && allPlayersHaveEqualTurns(state)) {
    finishGame(state);
  }
  state.turnReady = true;
};

const awardNoble = (
  state: SplendorState,
  playerID: PlayerID,
  nobleID: string,
): void => {
  state.availableNobleIds = state.availableNobleIds.filter(
    (id) => id !== nobleID,
  );
  state.players[playerID].nobleIds.push(nobleID);
};

const resolveNoblesOrComplete = (
  state: SplendorState,
  playerID: PlayerID,
): void => {
  const eligible = getEligibleNobleIDs(state, playerID);
  if (eligible.length === 0) {
    completeTurn(state, playerID);
    return;
  }
  if (eligible.length === 1) {
    awardNoble(state, playerID, eligible[0]);
    completeTurn(state, playerID);
    return;
  }
  state.pending = {
    type: 'noble',
    playerID,
    eligibleNobleIds: eligible,
  };
};

const resolveAfterMainAction = (
  state: SplendorState,
  playerID: PlayerID,
): void => {
  const overage = totalTokens(state.players[playerID].tokens) - 10;
  if (overage > 0) {
    state.pending = { type: 'discard', playerID, count: overage };
    return;
  }
  resolveNoblesOrComplete(state, playerID);
};

export const applyFastMainAction = (
  sim: FastSim,
  playerID: PlayerID,
  action: MainAction,
): boolean => {
  const state = sim.G;
  if (state.result !== null || state.pending !== null) return false;
  if (playerID !== sim.currentPlayer) return false;
  const player = state.players[playerID];
  if (!player) return false;

  switch (action.type) {
    case 'takeSame': {
      if (state.bank[action.color] < 4) return false;
      state.bank[action.color] -= 2;
      player.tokens[action.color] += 2;
      resolveAfterMainAction(state, playerID);
      break;
    }
    case 'takeDifferent': {
      for (const color of action.colors) {
        if (state.bank[color] < 1) return false;
      }
      for (const color of action.colors) {
        state.bank[color] -= 1;
        player.tokens[color] += 1;
      }
      resolveAfterMainAction(state, playerID);
      break;
    }
    case 'reserveMarket': {
      if (player.reservedCards.length >= 3) return false;
      const slotIndex = state.market[action.tier].indexOf(action.cardId);
      if (slotIndex < 0) return false;
      state.market[action.tier][slotIndex] = null;
      player.reservedCards.push({
        cardId: action.cardId,
        tier: action.tier,
        source: 'market',
      });
      state.market[action.tier][slotIndex] = state.decks[action.tier].shift() ?? null;
      if (state.bank.gold > 0) {
        state.bank.gold -= 1;
        player.tokens.gold += 1;
      }
      resolveAfterMainAction(state, playerID);
      break;
    }
    case 'reserveDeck': {
      if (player.reservedCards.length >= 3) return false;
      const cardID = state.decks[action.tier].shift();
      if (!cardID) return false;
      player.reservedCards.push({
        cardId: cardID,
        tier: action.tier,
        source: 'deck',
      });
      if (state.bank.gold > 0) {
        state.bank.gold -= 1;
        player.tokens.gold += 1;
      }
      resolveAfterMainAction(state, playerID);
      break;
    }
    case 'purchase': {
      const cardID = action.location.cardId;
      let vacatedSlot = -1;
      if (action.location.source === 'market') {
        vacatedSlot = state.market[action.location.tier].indexOf(cardID);
        if (vacatedSlot < 0) return false;
        state.market[action.location.tier][vacatedSlot] = null;
      } else {
        const reservedIndex = player.reservedCards.findIndex(
          (reserved) => reserved.cardId === cardID,
        );
        if (reservedIndex < 0) return false;
        player.reservedCards.splice(reservedIndex, 1);
      }
      for (const color of TOKEN_COLORS) {
        const amount = action.payment[color];
        if (amount < 0 || amount > player.tokens[color]) return false;
        player.tokens[color] -= amount;
        state.bank[color] += amount;
      }
      player.purchasedCardIds.push(cardID);
      if (action.location.source === 'market') {
        state.market[action.location.tier][vacatedSlot] =
          state.decks[action.location.tier].shift() ?? null;
      }
      resolveAfterMainAction(state, playerID);
      break;
    }
    case 'pass': {
      resolveAfterMainAction(state, playerID);
      break;
    }
    default:
      return false;
  }
  advanceIfTurnComplete(sim);
  return true;
};

export const applyFastDiscard = (
  sim: FastSim,
  playerID: PlayerID,
  returned: TokenCounts,
): boolean => {
  const state = sim.G;
  if (
    playerID !== sim.currentPlayer ||
    !state.pending ||
    state.pending.type !== 'discard' ||
    state.pending.playerID !== playerID
  ) {
    return false;
  }
  const player = state.players[playerID];
  let returnedTotal = 0;
  for (const color of TOKEN_COLORS) {
    const amount = returned[color] ?? 0;
    if (!Number.isSafeInteger(amount) || amount < 0) return false;
    if (amount > player.tokens[color]) return false;
    returnedTotal += amount;
  }
  if (returnedTotal !== state.pending.count) return false;
  for (const color of TOKEN_COLORS) {
    player.tokens[color] -= returned[color];
    state.bank[color] += returned[color];
  }
  state.pending = null;
  resolveNoblesOrComplete(state, playerID);
  advanceIfTurnComplete(sim);
  return true;
};

export const applyFastNoble = (
  sim: FastSim,
  playerID: PlayerID,
  nobleID: string,
): boolean => {
  const state = sim.G;
  if (
    playerID !== sim.currentPlayer ||
    !state.pending ||
    state.pending.type !== 'noble' ||
    state.pending.playerID !== playerID
  ) {
    return false;
  }
  if (
    !state.pending.eligibleNobleIds.includes(nobleID) ||
    !getEligibleNobleIDs(state, playerID).includes(nobleID)
  ) {
    return false;
  }
  state.pending = null;
  awardNoble(state, playerID, nobleID);
  completeTurn(state, playerID);
  advanceIfTurnComplete(sim);
  return true;
};

export const applyFastMove = (
  sim: FastSim,
  playerID: PlayerID,
  move: BotMove,
): boolean => {
  const [argument] = move.args;
  if (move.move === 'mainAction') {
    return applyFastMainAction(sim, playerID, argument as MainAction);
  }
  if (move.move === 'discardTokens') {
    return applyFastDiscard(sim, playerID, argument as TokenCounts);
  }
  return applyFastNoble(sim, playerID, argument as string);
};

/** Alias mirroring the search's usage sites. */
export const cloneForSearch = cloneStateFast;
