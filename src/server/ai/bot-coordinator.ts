/**
 * Per-match Bot lifecycle: spawns one BotController per Bot seat when a match
 * starts, stops them on deletion, and issues loopback access tickets.
 */

import type { AppConfig } from '../config.js';
import type { MatchDatabase, MatchMetadata } from '../multiplayer/lobby.js';
import type { GameAccessTicketService } from '../multiplayer/access-tickets.js';
import type { RoomRegistry } from '../multiplayer/room-registry.js';
import type { BotSeatMetadata } from './bot-seat.js';
import { BotController } from './bot-controller.js';
import type { AiWorkerPool } from './worker-pool.js';
import type { AiMetrics } from './metrics.js';
import { shortHash } from './sanitize.js';

const BOT_TICKET_TTL_MS = 12 * 60 * 60_000;

export class BotCoordinator {
  private readonly controllers = new Map<string, BotController[]>();
  private pool?: AiWorkerPool;

  constructor(
    private readonly dependencies: {
      db: MatchDatabase;
      rooms: RoomRegistry;
      tickets: GameAccessTicketService;
      config: AppConfig;
      weights: Record<string, number>;
      metrics?: AiMetrics;
    },
  ) {}

  setPool(pool: AiWorkerPool): void {
    this.pool = pool;
  }

  async startMatch(matchID: string): Promise<void> {
    if (!this.dependencies.config.aiBotEnabled) return;
    this.stopMatch(matchID);
    const room = this.dependencies.rooms.get(matchID);
    if (!room || room.startedAt === null) return;
    const result = await Promise.resolve(
      this.dependencies.db.fetch(matchID, { metadata: true }),
    );
    const metadata = result.metadata as MatchMetadata | undefined;
    if (!metadata) return;

    const controllers: BotController[] = [];
    for (const [seatID, player] of Object.entries(metadata.players)) {
      const data = player?.data as BotSeatMetadata | undefined;
      if (data?.kind !== 'bot') continue;
      const ticket = this.dependencies.tickets.issueBotTicket({
        botId: data.botId,
        matchID,
        playerID: seatID,
        ttlMs: BOT_TICKET_TTL_MS,
      });
      const controller = new BotController({
        matchID,
        playerID: seatID,
        botId: data.botId,
        difficulty: data.difficulty,
        modelVersion: data.modelVersion,
        accessTicket: ticket.accessTicket,
        credentials: player.credentials ?? '',
        serverURL: `http://127.0.0.1:${this.dependencies.config.port}`,
        pool: this.pool,
        weights: this.dependencies.weights,
        hardMaxMs: this.dependencies.config.aiBotHardMaxMs,
        expertEnabled: this.dependencies.config.aiBotExpertEnabled,
        metrics: this.dependencies.metrics,
        onError: (error) => {
          console.error(
            `[bot-controller] match=${shortHash(matchID)} seat=${seatID}: ${
              error instanceof Error ? error.message : 'unknown error'
            }`,
          );
        },
      });
      controllers.push(controller);
      controller.start();
    }
    if (controllers.length > 0) {
      this.controllers.set(matchID, controllers);
    }
  }

  stopMatch(matchID: string): void {
    for (const controller of this.controllers.get(matchID) ?? []) {
      controller.stop();
    }
    this.controllers.delete(matchID);
  }

  stopAll(): void {
    for (const matchID of [...this.controllers.keys()]) {
      this.stopMatch(matchID);
    }
  }
}
