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
} from '../../shared/ai/policy.js';
import { createObservation } from '../../shared/ai/observation.js';
import { createSeededRNG } from '../../shared/ai/seeded-rng.js';
import type {
  BotDifficulty,
  BoardContextView,
} from '../../shared/ai/types.js';
import type { SplendorState } from '../../shared/types/game.js';

type GameClient = ReturnType<typeof Client<SplendorState>>;

export interface BotControllerOptions {
  matchID: string;
  playerID: string;
  botId: string;
  difficulty: BotDifficulty;
  modelVersion: string;
  accessTicket: string;
  credentials: string;
  serverURL: string;
  thinkDelayMinMs?: number;
  thinkDelayMaxMs?: number;
  onError?: (error: unknown) => void;
}

export class BotController {
  private client?: GameClient;
  private stopped = false;
  private generation = 0;
  private lastStateID = -1;
  private thinking = false;
  private timer?: ReturnType<typeof setTimeout>;

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
        socketOpts: { auth: { accessTicket } },
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
    if (state._stateID < this.lastStateID) return;
    this.lastStateID = state._stateID;

    const G = state.G as SplendorState;
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
    const min = this.options.thinkDelayMinMs ?? 350;
    const max = this.options.thinkDelayMaxMs ?? 650;
    const delay = min + jitter.next() * (max - min);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || generation !== this.generation) return;
      if (this.lastStateID !== stateID) return;
      void this.thinkAndSubmit(state, generation, stateID);
    }, delay);
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
      const decision = chooseEasyBotMove(observation, ctx, {
        seed: `${this.options.matchID}:${playerID}:${stateID}`,
      });
      if (this.stopped || generation !== this.generation) return;
      if (this.lastStateID !== stateID) return;
      const moveType = decision.move.move;
      const args = decision.move.args;
      (this.client?.moves as unknown as Record<string, (...rest: unknown[]) => void>)[
        moveType
      ](...args);
    } catch (caught) {
      if (caught instanceof NoLegalActionError) {
        this.options.onError?.(caught);
        return;
      }
      this.options.onError?.(caught);
    } finally {
      this.thinking = false;
    }
  }
}
