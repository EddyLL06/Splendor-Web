/**
 * Core AI kernel types (DEVELOPMENT_GUIDE.md §3.2).
 */

import type {
  MainAction,
  PlayerID,
  TokenCounts,
} from '../types/game.js';

export const BOT_DIFFICULTIES = ['easy', 'normal', 'hard', 'expert'] as const;
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number];

export const isBotDifficulty = (value: unknown): value is BotDifficulty =>
  typeof value === 'string' &&
  (BOT_DIFFICULTIES as readonly string[]).includes(value);

export const AI_AGENTS = [
  'uniform-random-v1',
  'cheap-greedy-v1',
] as const;
export type AgentPolicyID = (typeof AI_AGENTS)[number];

export type BotMove =
  | { move: 'mainAction'; args: [MainAction] }
  | { move: 'discardTokens'; args: [TokenCounts] }
  | { move: 'chooseNoble'; args: [string] };

export interface SearchBudget {
  deadlineEpochMs: number;
  maxNodes: number;
  beamWidth: number;
  maxDeterminizations: number;
  maxSimulations: number;
}

export interface BotDecision {
  move: BotMove;
  modelVersion: string;
  policy: AgentPolicyID | 'easy-v1';
  seed: string;
  nodesVisited: number;
  elapsedMs: number;
  timedOut: boolean;
  fallbackLevel: 0 | 1 | 2;
}

/** Small context subset needed to decide and advance a simulation. */
export interface BoardContextView {
  currentPlayer: PlayerID;
  playOrder: PlayerID[];
  playOrderPos: number;
}
