/**
 * Compact per-match memory for Expert bots (DEVELOPMENT_GUIDE.md §5/§17).
 *
 * The memory is a deterministic reducer over the *public* observations the
 * bot has seen: it never stores deck order, opponent blind reservation card
 * IDs, credentials or any hidden truth. Identical playerViews therefore
 * always produce identical memory, preserving the hidden-information
 * invariant. The snapshot is plain structured-cloneable data so it can cross
 * the worker-thread boundary.
 */

import type {
  PlayerID,
  TokenColor,
  TokenCounts,
} from '../types/game.js';
import type { AIObservation, PlayerObservation } from './observation.js';

export type OpponentLastAction =
  | 'purchase'
  | 'reserve'
  | 'noble'
  | 'take'
  | 'discard'
  | 'unknown';

export interface PlayerMemory {
  /** Turns this player has completed (from the public turn counter). */
  turnCount: number;
  /** Most recent detectable action type. */
  lastAction: OpponentLastAction;
  /** Full turns completed by others since this player's last action. */
  lastActionTurnsAgo: number;
  purchases: number;
  reservesByTier: [number, number, number];
  nobles: number;
  gold: number;
  /** Last 4 token-taking colors (helps read opponent card building). */
  recentTakeQueue: TokenColor[];
  /** Last observed token counts, used only to detect action deltas. */
  lastTokens: TokenCounts;
}

export interface ExpertMemorySnapshot {
  completedTurns: number;
  players: Record<PlayerID, PlayerMemory>;
}

const emptyTokens = (): TokenCounts => ({
  white: 0,
  blue: 0,
  green: 0,
  red: 0,
  black: 0,
  gold: 0,
});

const emptyPlayer = (): PlayerMemory => ({
  turnCount: 0,
  lastAction: 'unknown',
  lastActionTurnsAgo: 0,
  purchases: 0,
  reservesByTier: [0, 0, 0],
  nobles: 0,
  gold: 0,
  recentTakeQueue: [],
  lastTokens: emptyTokens(),
});

export const emptyMemory = (
  playerOrder: PlayerID[],
): ExpertMemorySnapshot => ({
  completedTurns: 0,
  players: Object.fromEntries(
    playerOrder.map((playerID) => [playerID, emptyPlayer()]),
  ) as Record<PlayerID, PlayerMemory>,
});

const tierIndex = (tier: 1 | 2 | 3): 0 | 1 | 2 => (tier - 1) as 0 | 1 | 2;

const reservesByTierOf = (
  player: PlayerObservation,
): [number, number, number] => {
  const counts: [number, number, number] = [0, 0, 0];
  for (const reserved of player.reservedCards) {
    counts[tierIndex(reserved.tier)] += 1;
  }
  return counts;
};

const tokenTotal = (tokens: TokenCounts): number =>
  Object.values(tokens).reduce((sum, count) => sum + count, 0);

/**
 * Baseline memory built from one observation. Used for the first state the
 * bot sees; afterwards call `updateMemory` with each newer observation.
 */
export const seedMemoryFromObservation = (
  observation: AIObservation,
): ExpertMemorySnapshot => {
  const memory = emptyMemory(observation.playerOrder);
  memory.completedTurns = observation.completedTurns;
  for (const playerID of observation.playerOrder) {
    const player = observation.players[playerID];
    const entry = memory.players[playerID];
    entry.turnCount = observation.turnCounts[playerID] ?? 0;
    entry.purchases = player.purchasedCardIds.length;
    entry.reservesByTier = reservesByTierOf(player);
    entry.nobles = player.nobleIds.length;
    entry.gold = player.tokens.gold;
    entry.lastTokens = { ...player.tokens };
  }
  return memory;
};

/**
 * Advances the memory by one public observation. Detects the last action of
 * each player from public deltas (turn counters and visible counts), so the
 * Expert can read opponents' behavior without ever seeing hidden cards.
 */
export const updateMemory = (
  memory: ExpertMemorySnapshot,
  observation: AIObservation,
): ExpertMemorySnapshot => {
  const next: ExpertMemorySnapshot = {
    completedTurns: observation.completedTurns,
    players: Object.fromEntries(
      observation.playerOrder.map((playerID) => {
        const previous = memory.players[playerID] ?? emptyPlayer();
        return [
          playerID,
          {
            ...previous,
            recentTakeQueue: [...previous.recentTakeQueue],
            lastTokens: { ...previous.lastTokens },
          },
        ];
      }),
    ) as Record<PlayerID, PlayerMemory>,
  };
  const advanced = Math.max(
    0,
    observation.completedTurns - memory.completedTurns,
  );

  for (const playerID of observation.playerOrder) {
    const player = observation.players[playerID];
    const entry = next.players[playerID];
    const turnCount = observation.turnCounts[playerID] ?? 0;
    const acted = turnCount > entry.turnCount;

    if (acted) {
      entry.lastActionTurnsAgo = 0;
      const nobles = player.nobleIds.length > entry.nobles;
      const purchases = player.purchasedCardIds.length > entry.purchases;
      const reserves = reservesByTierOf(player);
      const reserved =
        reserves[0] + reserves[1] + reserves[2] >
        entry.reservesByTier[0] +
          entry.reservesByTier[1] +
          entry.reservesByTier[2];
      const currentTotal = tokenTotal(player.tokens);
      if (nobles) {
        entry.lastAction = 'noble';
      } else if (purchases) {
        entry.lastAction = 'purchase';
      } else if (reserved) {
        entry.lastAction = 'reserve';
      } else if (currentTotal > tokenTotal(entry.lastTokens)) {
        entry.lastAction = 'take';
        for (const color of ['white', 'blue', 'green', 'red', 'black'] as const) {
          const gained = player.tokens[color] - entry.lastTokens[color];
          for (let index = 0; index < gained; index += 1) {
            entry.recentTakeQueue.push(color);
          }
        }
        while (entry.recentTakeQueue.length > 4) entry.recentTakeQueue.shift();
      } else if (currentTotal < tokenTotal(entry.lastTokens)) {
        entry.lastAction = 'discard';
      } else {
        entry.lastAction = 'unknown';
      }
    } else {
      entry.lastActionTurnsAgo += advanced;
    }

    entry.turnCount = turnCount;
    entry.purchases = player.purchasedCardIds.length;
    entry.reservesByTier = reservesByTierOf(player);
    entry.nobles = player.nobleIds.length;
    entry.gold = player.tokens.gold;
    entry.lastTokens = { ...player.tokens };
  }
  return next;
};
