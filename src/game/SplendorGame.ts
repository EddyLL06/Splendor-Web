import { INVALID_MOVE } from 'boardgame.io/dist/cjs/core.js';
import type { Game, MoveFn } from 'boardgame.io';

import {
  applyDiscard,
  applyMainAction,
  applyNobleSelection,
} from '../shared/rules/engine.js';
import { createInitialState } from '../shared/rules/setup.js';
import type {
  MainAction,
  SplendorState,
  TokenCounts,
} from '../shared/types/game.js';
import { createPlayerView } from './playerView.js';

const mainActionMove: MoveFn<SplendorState> = (
  { G, ctx, playerID },
  action: MainAction,
) => {
  const result = applyMainAction(G, playerID, ctx.currentPlayer, action);
  return result.ok ? result.value : INVALID_MOVE;
};

const discardMove: MoveFn<SplendorState> = (
  { G, ctx, playerID },
  returned: TokenCounts,
) => {
  const result = applyDiscard(G, playerID, ctx.currentPlayer, returned);
  return result.ok ? result.value : INVALID_MOVE;
};

const chooseNobleMove: MoveFn<SplendorState> = (
  { G, ctx, playerID },
  nobleID: string,
) => {
  const result = applyNobleSelection(
    G,
    playerID,
    ctx.currentPlayer,
    nobleID,
  );
  return result.ok ? result.value : INVALID_MOVE;
};

export const SplendorGame: Game<SplendorState> = {
  name: 'gem-council',
  minPlayers: 2,
  maxPlayers: 4,
  disableUndo: true,
  setup: ({ ctx, random }) => createInitialState(ctx.numPlayers, random),
  playerView: ({ G, playerID }) => createPlayerView(G, playerID),
  moves: {
    mainAction: { move: mainActionMove, client: false },
    discardTokens: { move: discardMove, client: false },
    chooseNoble: { move: chooseNobleMove, client: false },
  },
  events: {
    endGame: false,
    endPhase: false,
    endTurn: false,
    setPhase: false,
    endStage: false,
    setStage: false,
    pass: false,
    setActivePlayers: false,
  },
  turn: {
    order: {
      first: ({ G }) => G.playerOrder.indexOf(G.initialFirstPlayer),
      next: ({ ctx }) => (ctx.playOrderPos + 1) % ctx.playOrder.length,
    },
    onBegin: ({ G }) => {
      G.turnReady = false;
    },
    endIf: ({ G }) => G.turnReady,
  },
  endIf: ({ G }) => G.result ?? undefined,
};
