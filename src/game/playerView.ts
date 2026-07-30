import type { PlayerID, SplendorState } from '../shared/types/game.js';

const HIDDEN_CARD_ID = '__hidden__';

export const createPlayerView = (
  state: SplendorState,
  playerID: PlayerID | null,
): SplendorState => {
  const view = JSON.parse(JSON.stringify(state)) as SplendorState;
  for (const tier of [1, 2, 3] as const) {
    view.decks[tier] = view.decks[tier].map(() => HIDDEN_CARD_ID);
  }
  for (const [ownerID, player] of Object.entries(view.players)) {
    if (ownerID === playerID) continue;
    player.reservedCards = player.reservedCards.map((reserved) =>
      reserved.source === 'deck'
        ? { ...reserved, cardId: null }
        : reserved,
    );
  }
  return view;
};
