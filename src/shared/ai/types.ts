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
  'normal-v1',
  'hard-v1',
  'expert-v1',
  'ds-search-v1',
  'ds-search-v2',
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
  /**
   * ds-search worker-slice fields: total determinizations plus this
   * worker's [detIndex, detIndex + detCount) slice. Optional so the beam /
   * micro-mcts budgets keep their original shape.
   */
  determinizations?: number;
  detIndex?: number;
  detCount?: number;
}

export interface BotSearchTraceAction {
  actionKey: string;
  visits: number;
  valueSum: number;
  mean: number;
}

export interface BotSearchTrace {
  /** Ranked root-candidate statistics backing the chosen move. */
  topActions: BotSearchTraceAction[];
  determinizations: number;
}

export interface BotDecision {
  move: BotMove;
  modelVersion: string;
  policy: AgentPolicyID | 'easy-v1' | 'neural-v1' | 'neural-puct-v1';
  seed: string;
  nodesVisited: number;
  elapsedMs: number;
  timedOut: boolean;
  fallbackLevel: 0 | 1 | 2;
  /** Optional search internals for the /bot insight page. */
  searchTrace?: BotSearchTrace;
}

/** Small context subset needed to decide and advance a simulation. */
export interface BoardContextView {
  currentPlayer: PlayerID;
  playOrder: PlayerID[];
  playOrderPos: number;
}
