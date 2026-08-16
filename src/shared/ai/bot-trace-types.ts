/**
 * Shared types for the /bot insight page: the Expert bot's per-decision
 * thinking record and a compact public game snapshot. Structured data only
 * (no hidden deck information); labels are rendered client-side.
 */

import type { BotMove } from './types.js';
import type {
  GemCounts,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../types/game.js';

export interface BotTraceActionStat {
  actionKey: string;
  visits: number;
  valueSum: number;
  mean: number;
}

export interface BotTraceDecision {
  id: number;
  playerID: PlayerID;
  stateID: number;
  move: BotMove;
  policy: string;
  modelVersion: string;
  /** Total simulations behind this decision (all determinizations). */
  sims: number;
  elapsedMs: number;
  timedOut: boolean;
  fallbackLevel: 0 | 1 | 2;
  determinizations: number;
  topActions: BotTraceActionStat[];
  createdAt: number;
}

export interface BotTracePlayerSnapshot {
  score: number;
  tokens: TokenCounts;
  bonuses: GemCounts;
  tokenTotal: number;
  purchasedCount: number;
  reservedCount: number;
  nobleCount: number;
}

export interface BotTraceSnapshot {
  stateID: number;
  currentPlayer: PlayerID;
  gameover: boolean;
  winners: PlayerID[];
  finalRound: boolean;
  completedTurns: number;
  turnCounts: Record<PlayerID, number>;
  pending: SplendorState['pending'];
  bank: TokenCounts;
  market: SplendorState['market'];
  deckCounts: Record<1 | 2 | 3, number>;
  players: Record<PlayerID, BotTracePlayerSnapshot>;
}

export interface BotTraceResponse {
  matchID: string;
  /** PlayerID of the Expert bot seat, when present. */
  botPlayerID: string | null;
  entries: BotTraceDecision[];
  snapshot: BotTraceSnapshot | null;
}
