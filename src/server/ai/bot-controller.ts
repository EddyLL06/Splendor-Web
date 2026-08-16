/**
 * One loopback boardgame.io client per active Bot seat (DEVELOPMENT_GUIDE.md
 * §4.3/§4.4). All AI computation is currently inline; the shared worker pool
 * arrives in round 4. The controller only ever acts when the authoritative
 * state says it is the Bot's turn, and drops results for stale generations.
 */

import { createRequire } from 'node:module';

// Stable CJS entry points (same style as the server's boardgame.io imports);
// the bare subpaths do not resolve under NodeNext in tsx/node. Types come
// from the package's typed bare subpaths.
const require = createRequire(import.meta.url);
const { Client } = require('boardgame.io/dist/cjs/client.js') as typeof import('boardgame.io/client');
const { SocketIO } = require('boardgame.io/dist/cjs/multiplayer.js') as typeof import('boardgame.io/multiplayer');

import { SplendorGame } from '../../game/SplendorGame.js';
import {
  NoLegalActionError,
  chooseEasyBotMove,
  chooseBotMove,
} from '../../shared/ai/policy.js';
import { computeHardDecision } from '../../shared/ai/search/beam.js';
import { computeDsSearchDecision } from '../../shared/ai/search/ds-search.js';
import { createObservation } from '../../shared/ai/observation.js';
import {
  seedMemoryFromObservation,
  updateMemory,
  type ExpertMemorySnapshot,
} from '../../shared/ai/memory.js';
import { createSeededRNG } from '../../shared/ai/seeded-rng.js';
import type {
  BotDifficulty,
  BoardContextView,
  BotDecision,
} from '../../shared/ai/types.js';
import type { AIObservation } from '../../shared/ai/observation.js';
import type { SplendorState } from '../../shared/types/game.js';
import type { AiWorkerPool } from './worker-pool.js';
import type { AiMetrics } from './metrics.js';
import type { BotTraceStore } from './bot-trace.js';
import { shortHash } from './sanitize.js';

type GameClient = ReturnType<typeof Client<SplendorState>>;

/**
 * Presentation delay before each Bot move so human players perceive the
 * Bot "thinking". Still deterministic per (match, seat, stateID).
 */
const DEFAULT_THINK_DELAY_MIN_MS = 2_000;
const DEFAULT_THINK_DELAY_MAX_MS = 5_000;

export interface BotControllerOptions {
  matchID: string;
  playerID: string;
  botId: string;
  difficulty: BotDifficulty;
  modelVersion: string;
  accessTicket: string;
  credentials: string;
  serverURL: string;
  /** Optional override for the pre-move presentation delay (ms). */
  thinkDelayMinMs?: number;
  /** Optional override for the pre-move presentation delay (ms). */
  thinkDelayMaxMs?: number;
  onError?: (error: unknown) => void;
  pool?: AiWorkerPool;
  weights: Record<string, number>;
  hardMaxMs: number;
  expertEnabled: boolean;
  expertMaxMs: number;
  expertSims: number;
  expertDeterminizations: number;
  metrics?: AiMetrics;
  /** Records each decision for the human-readable /bot insight page. */
  traceStore?: BotTraceStore;
}

export class BotController {
  private client?: GameClient;
  private stopped = false;
  private generation = 0;
  private lastStateID = -1;
  private thinking = false;
  private timer?: ReturnType<typeof setTimeout>;
  private memory?: ExpertMemorySnapshot;
  private pendingDecision?: {
    generation: number;
    stateID: number;
    promise: Promise<BotDecision>;
  };

  constructor(private readonly options: BotControllerOptions) {}

  start(): void {
    if (this.stopped) return;
    const { matchID, playerID, credentials, accessTicket, serverURL } =
      this.options;
    const client = Client<SplendorState>({
      game: SplendorGame,
      matchID,
      playerID,
      credentials,
      multiplayer: SocketIO({
        server: serverURL,
        socketOpts: { auth: { accessTicket }, transports: ['websocket'] },
      }),
    });
    this.client = client;
    client.subscribe((state) => this.onState(state));
    client.start();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.client?.stop();
    this.client = undefined;
  }

  private onState(state: ReturnType<GameClient['getState']>): void {
    if (this.stopped || !state || !state.isConnected) return;
    // Skip stale AND duplicate deliveries: socket reconnects/resyncs can
    // re-send the same state, and restarting the (uncancellable) worker
    // search per duplicate floods the pool queue (watchdog timeouts).
    if (state._stateID <= this.lastStateID) return;
    this.lastStateID = state._stateID;

    const G = state.G as SplendorState;
    const viewCtx: BoardContextView = {
      currentPlayer: state.ctx.currentPlayer,
      playOrder: state.ctx.playOrder,
      playOrderPos: state.ctx.playOrderPos,
    };
    const memoryObservation = createObservation(G, this.options.playerID, viewCtx);
    this.memory = this.memory
      ? updateMemory(this.memory, memoryObservation)
      : seedMemoryFromObservation(memoryObservation);
    if (G.result !== null || state.ctx.gameover !== undefined) {
      this.stop();
      return;
    }
    if (state.ctx.currentPlayer !== this.options.playerID) return;
    if (G.pending !== null && G.pending.playerID !== this.options.playerID) {
      return;
    }

    const generation = ++this.generation;
    const stateID = state._stateID;
    const jitter = createSeededRNG(
      `${this.options.matchID}:${this.options.playerID}:${stateID}`,
    );
    const min = this.options.thinkDelayMinMs ?? DEFAULT_THINK_DELAY_MIN_MS;
    const max = this.options.thinkDelayMaxMs ?? DEFAULT_THINK_DELAY_MAX_MS;
    const delay = min + jitter.next() * (max - min);
    if (this.timer) clearTimeout(this.timer);
    // Expert search runs in parallel with the presentation delay so the
    // total wall time per move is ~max(delay, search) instead of the sum.
    if (this.options.difficulty === 'expert') {
      this.pendingDecision = {
        generation,
        stateID,
        promise: this.computeDecisionForState(state, generation, stateID),
      };
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || generation !== this.generation) return;
      if (this.lastStateID !== stateID) return;
      void this.thinkAndSubmit(state, generation, stateID);
    }, delay);
  }

  private computeDecisionForState(
    state: NonNullable<ReturnType<GameClient['getState']>>,
    generation: number,
    stateID: number,
  ): Promise<BotDecision> {
    const playerID = this.options.playerID;
    const ctx: BoardContextView = {
      currentPlayer: playerID,
      playOrder: state.ctx.playOrder,
      playOrderPos: state.ctx.playOrderPos,
    };
    const observation = createObservation(
      state.G as SplendorState,
      playerID,
      ctx,
    );
    const seed = `${this.options.matchID}:${playerID}:${stateID}`;
    void generation;
    void stateID;
    return this.computeDecision(observation, ctx, seed);
  }

  private async thinkAndSubmit(
    state: NonNullable<ReturnType<GameClient['getState']>>,
    generation: number,
    stateID: number,
  ): Promise<void> {
    if (this.stopped || this.thinking) return;
    if (generation !== this.generation || this.lastStateID !== stateID) return;
    this.thinking = true;
    try {
      const playerID = this.options.playerID;
      const ctx: BoardContextView = {
        currentPlayer: playerID,
        playOrder: state.ctx.playOrder,
        playOrderPos: state.ctx.playOrderPos,
      };
      const observation = createObservation(
        state.G as SplendorState,
        playerID,
        ctx,
      );
      const seed = `${this.options.matchID}:${playerID}:${stateID}`;
      const pending = this.pendingDecision;
      const decision =
        pending &&
        pending.generation === generation &&
        pending.stateID === stateID
          ? await pending.promise
          : await this.computeDecision(observation, ctx, seed);
      if (this.stopped || generation !== this.generation) {
        this.options.metrics?.recordStaleResult();
        return;
      }
      if (this.lastStateID !== stateID) {
        this.options.metrics?.recordStaleResult();
        return;
      }
      if (this.options.traceStore && this.options.difficulty === 'expert') {
        this.options.traceStore.record(this.options.matchID, {
          playerID,
          stateID,
          move: decision.move,
          policy: decision.policy,
          modelVersion: decision.modelVersion,
          sims: decision.nodesVisited,
          elapsedMs: decision.elapsedMs,
          timedOut: decision.timedOut,
          fallbackLevel: decision.fallbackLevel,
          determinizations:
            decision.searchTrace?.determinizations ??
            this.options.expertDeterminizations,
          topActions: decision.searchTrace?.topActions ?? [],
        });
      }
      const moveType = decision.move.move;
      const args = decision.move.args;
      (this.client?.moves as unknown as Record<string, (...rest: unknown[]) => void>)[
        moveType
      ](...args);
    } catch (caught) {
      if (caught instanceof NoLegalActionError) {
        this.options.metrics?.recordNoLegalAction();
        this.options.onError?.(caught);
        return;
      }
      this.options.onError?.(caught);
    } finally {
      this.thinking = false;
      this.pendingDecision = undefined;
    }
  }

  private async computeDecision(
    observation: AIObservation,
    ctx: BoardContextView,
    seed: string,
  ): Promise<BotDecision> {
    if (this.options.difficulty === 'easy') {
      return chooseEasyBotMove(observation, ctx, { seed });
    }
    if (this.options.difficulty === 'normal') {
      return chooseBotMove(observation, ctx, {
        policy: 'normal-v1',
        seed,
        weights: this.options.weights,
      });
    }
    const expertMode =
      this.options.difficulty === 'expert' && this.options.expertEnabled;
    const budget = expertMode
      ? {
          deadlineEpochMs:
            performance.now() + this.options.expertMaxMs,
          maxNodes: 0,
          beamWidth: 0,
          maxDeterminizations: this.options.expertDeterminizations,
          maxSimulations: this.options.expertSims,
        }
      : {
          deadlineEpochMs:
            performance.now() + this.options.hardMaxMs,
          maxNodes: 800,
          beamWidth: 5,
          maxDeterminizations: 1,
          maxSimulations: 0,
        };
    try {
      if (this.options.pool) {
        const input = {
          observation,
          ctx,
          seed,
          weights: this.options.weights,
          budget,
          memory: this.memory,
        };
        const decision = expertMode
          ? await this.options.pool.requestExpertDecision(input, 'live')
          : await this.options.pool.requestHardDecision(input, 'live');
        this.options.metrics?.recordDecision(
          decision.elapsedMs,
          this.options.difficulty,
        );
        return decision;
      }
      const input = {
        observation,
        ctx,
        seed,
        weights: this.options.weights,
        budget,
        memory: this.memory,
      };
      const decision = expertMode
        ? (computeDsSearchDecision({
            ...input,
            budget: {
              deadlineEpochMs: budget.deadlineEpochMs,
              maxSimulations: budget.maxSimulations,
              determinizations: budget.maxDeterminizations,
              detIndex: 0,
              detCount: budget.maxDeterminizations,
            },
          }).decision)
        : computeHardDecision(input);
      this.options.metrics?.recordDecision(
        decision.elapsedMs,
        this.options.difficulty,
      );
      return decision;
    } catch (caught) {
      if (
        caught instanceof Error &&
        /WATCHDOG|QUEUE_FULL/.test(caught.message)
      ) {
        this.options.metrics?.recordTimeout();
      }
      // The search failure must be visible in the logs (it is otherwise
      // silent): this is the only place an Expert decision degrades.
      console.error(
        `[bot-controller] expert search failed for match=${shortHash(
          this.options.matchID,
        )} seat=${this.options.playerID}: ${
          caught instanceof Error ? caught.message : String(caught)
        } — falling back to normal-v1`,
      );
      this.options.metrics?.recordFallback('search');
      const fallback = chooseBotMove(observation, ctx, {
        policy: 'normal-v1',
        seed,
        weights: this.options.weights,
      });
      this.options.metrics?.recordDecision(
        fallback.elapsedMs,
        this.options.difficulty,
      );
      return { ...fallback, fallbackLevel: 2 as const };
    }
  }
}
