/**
 * Per-match record of the Expert bot's thinking process, exposed to the
 * human-readable /bot insight page.
 *
 * The store keeps only aggregate, public decision data (chosen move, root
 * candidate statistics, budgets) — never deck order, opponent blind
 * reservation card IDs, credentials or tickets. Entries are capped per
 * match and dropped with the match.
 */

import type {
  BotTraceDecision,
  BotTracePlayerSnapshot,
  BotTraceSnapshot,
} from '../../shared/ai/bot-trace-types.js';
import type {
  PlayerID,
  SplendorState,
} from '../../shared/types/game.js';
import {
  getBonuses,
  getScore,
  totalTokens,
} from '../../shared/rules/selectors.js';

export const buildBotTraceSnapshot = (
  G: SplendorState,
  currentPlayer: PlayerID,
  stateID: number,
): BotTraceSnapshot => {
  const players = Object.fromEntries(
    G.playerOrder.map((playerID) => {
      const player = G.players[playerID];
      return [
        playerID,
        {
          score: getScore(G, playerID),
          tokens: { ...player.tokens },
          bonuses: getBonuses(G, playerID),
          tokenTotal: totalTokens(player.tokens),
          purchasedCount: player.purchasedCardIds.length,
          reservedCount: player.reservedCards.length,
          nobleCount: player.nobleIds.length,
        },
      ];
    }),
  ) as Record<PlayerID, BotTracePlayerSnapshot>;
  return {
    stateID,
    currentPlayer,
    gameover: G.result !== null,
    winners: G.result?.winners ?? [],
    finalRound: G.finalRound !== null,
    completedTurns: G.completedTurns,
    turnCounts: { ...G.turnCounts },
    pending: G.pending
      ? JSON.parse(JSON.stringify(G.pending))
      : null,
    bank: { ...G.bank },
    market: JSON.parse(JSON.stringify(G.market)),
    deckCounts: {
      1: G.decks[1].length,
      2: G.decks[2].length,
      3: G.decks[3].length,
    },
    players,
  };
};

const MAX_ENTRIES_PER_MATCH = 60;

export class BotTraceStore {
  private readonly byMatch = new Map<string, BotTraceDecision[]>();
  private nextID = 1;

  record(
    matchID: string,
    entry: Omit<BotTraceDecision, 'id' | 'createdAt'>,
  ): void {
    const list = this.byMatch.get(matchID) ?? [];
    list.push({ ...entry, id: this.nextID++, createdAt: Date.now() });
    if (list.length > MAX_ENTRIES_PER_MATCH) {
      list.splice(0, list.length - MAX_ENTRIES_PER_MATCH);
    }
    this.byMatch.set(matchID, list);
  }

  forMatch(matchID: string): BotTraceDecision[] {
    return this.byMatch.get(matchID) ?? [];
  }

  clear(matchID: string): void {
    this.byMatch.delete(matchID);
  }

  clearAll(): void {
    this.byMatch.clear();
  }
}
