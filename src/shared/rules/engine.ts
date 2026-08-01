import {
  NORMAL_COLORS,
  TOKEN_COLORS,
  emptyTokenCounts,
  isGemColor,
} from '../constants/colors.js';
import { getCard, requireNoble } from '../data/gameData.js';
import type {
  ActionAnimation,
  MainAction,
  PlayerID,
  RuleError,
  RuleResult,
  SplendorState,
  Tier,
  TokenColor,
  TokenCounts,
} from '../types/game.js';
import {
  analyzePayment,
  createStandings,
  findPurchasableCard,
  formatTokenSelection,
  getEligibleNobleIDs,
  getScore,
  playerLabel,
  totalTokens,
} from './selectors.js';

const success = (state: SplendorState): RuleResult<SplendorState> => ({
  ok: true,
  value: state,
});

const failure = (code: string, message: string): RuleResult<SplendorState> => ({
  ok: false,
  errors: [{ code, message }],
});

const failures = (errors: RuleError[]): RuleResult<SplendorState> => ({
  ok: false,
  errors,
});

const isTier = (value: unknown): value is Tier =>
  value === 1 || value === 2 || value === 3;

const isTokenColorValue = (value: unknown): value is TokenColor =>
  typeof value === 'string' &&
  (TOKEN_COLORS as readonly string[]).includes(value);

const cloneState = (state: SplendorState): SplendorState =>
  JSON.parse(JSON.stringify(state)) as SplendorState;

const addLog = (
  state: SplendorState,
  kind: SplendorState['actionLog'][number]['kind'],
  message: string,
  i18n?: SplendorState['actionLog'][number]['i18n'],
  animation?: ActionAnimation,
): void => {
  state.actionLog.push({
    id: state.nextLogID,
    kind,
    message,
    ...(i18n ? { i18n } : {}),
    ...(animation ? { animation } : {}),
  });
  state.nextLogID += 1;
  if (state.actionLog.length > 40) {
    state.actionLog.splice(0, state.actionLog.length - 40);
  }
};

const refillMarketSlot = (
  state: SplendorState,
  tier: Tier,
  slotIndex: number,
): string | null => {
  const replacement = state.decks[tier].shift() ?? null;
  state.market[tier][slotIndex] = replacement;
  return replacement;
};

const allPlayersHaveEqualTurns = (state: SplendorState): boolean => {
  const counts = state.playerOrder.map(
    (playerID) => state.turnCounts[playerID],
  );
  return counts.every((count) => count === counts[0]);
};

const finishGame = (state: SplendorState): void => {
  const standings = createStandings(state);
  const leader = standings[0];
  const winners = standings
    .filter(
      (standing) =>
        standing.score === leader.score &&
        standing.purchasedCardCount === leader.purchasedCardCount,
    )
    .map((standing) => standing.playerID);
  state.result = { winners, standings };
  addLog(
    state,
    'game-over',
    winners.length === 1
      ? `${playerLabel(winners[0])} won the game.`
      : `${winners.map(playerLabel).join(' and ')} shared the victory.`,
    winners.length === 1
      ? { key: 'win', values: { playerID: winners[0] } }
      : { key: 'sharedWin', values: { playerIDs: winners } },
  );
};

const completeTurn = (state: SplendorState, playerID: PlayerID): void => {
  state.pending = null;
  state.completedTurns += 1;
  state.turnCounts[playerID] += 1;

  if (!state.finalRound && getScore(state, playerID) >= 15) {
    state.finalRound = {
      triggeredBy: playerID,
      triggeredAtCompletedTurn: state.completedTurns,
    };
    addLog(
      state,
      'final-round',
    `${playerLabel(playerID)} reached 15 prestige; the final round began.`,
    { key: 'finalRound', values: { playerID } },
    );
  }

  if (state.finalRound && allPlayersHaveEqualTurns(state)) {
    finishGame(state);
  }
  state.turnReady = true;
};

const awardNoble = (
  state: SplendorState,
  playerID: PlayerID,
  nobleID: string,
): void => {
  requireNoble(nobleID);
  state.availableNobleIds = state.availableNobleIds.filter(
    (id) => id !== nobleID,
  );
  state.players[playerID].nobleIds.push(nobleID);
  addLog(
    state,
    'noble',
    `${playerLabel(playerID)} received noble ${nobleID}.`,
    { key: 'noble', values: { playerID, noble: nobleID } },
  );
};

const resolveNoblesOrComplete = (
  state: SplendorState,
  playerID: PlayerID,
): void => {
  const eligible = getEligibleNobleIDs(state, playerID);
  if (eligible.length === 0) {
    completeTurn(state, playerID);
    return;
  }
  if (eligible.length === 1) {
    awardNoble(state, playerID, eligible[0]);
    completeTurn(state, playerID);
    return;
  }
  state.pending = {
    type: 'noble',
    playerID,
    eligibleNobleIds: eligible,
  };
};

const resolveAfterMainAction = (
  state: SplendorState,
  playerID: PlayerID,
): void => {
  const overage = totalTokens(state.players[playerID].tokens) - 10;
  if (overage > 0) {
    state.pending = { type: 'discard', playerID, count: overage };
    return;
  }
  resolveNoblesOrComplete(state, playerID);
};

const validateActor = (
  state: SplendorState,
  playerID: PlayerID,
  currentPlayerID: PlayerID,
): RuleResult<SplendorState> | null => {
  if (!state.players[playerID]) {
    return failure('PLAYER_NOT_FOUND', 'Player was not found.');
  }
  if (state.result) {
    return failure('GAME_OVER', 'The game is already over.');
  }
  if (state.turnReady) {
    return failure('TURN_COMPLETE', 'This turn is already complete.');
  }
  if (playerID !== currentPlayerID) {
    return failure('OUT_OF_TURN', 'It is not your turn.');
  }
  return null;
};

const takeDifferent = (
  state: SplendorState,
  playerID: PlayerID,
  colors: TokenColor[],
): RuleResult<SplendorState> => {
  if (
    !Array.isArray(colors) ||
    colors.length !== 3 ||
    !colors.every(isTokenColorValue)
  ) {
    return failure(
      'TAKE_DIFFERENT_COUNT',
      'Choose exactly three normal gem colors.',
    );
  }
  if (colors.some((color) => !isGemColor(color))) {
    return failure('TAKE_GOLD', 'Gold cannot be taken as a normal gem.');
  }
  if (new Set(colors).size !== 3) {
    return failure(
      'TAKE_DIFFERENT_DUPLICATE',
      'The three selected gem colors must be different.',
    );
  }
  for (const color of colors) {
    if (state.bank[color] < 1) {
      return failure(
        'TAKE_UNAVAILABLE',
        `No ${color} token is available in the bank.`,
      );
    }
  }

  const next = cloneState(state);
  for (const color of colors) {
    next.bank[color] -= 1;
    next.players[playerID].tokens[color] += 1;
  }
  addLog(
    next,
    'tokens',
    `${playerLabel(playerID)} took one ${colors.join(', ')} token.`,
    { key: 'different', values: { playerID, colors } },
  );
  resolveAfterMainAction(next, playerID);
  return success(next);
};

const takeSame = (
  state: SplendorState,
  playerID: PlayerID,
  color: TokenColor,
): RuleResult<SplendorState> => {
  if (!isTokenColorValue(color) || !isGemColor(color)) {
    return failure(
      'TAKE_GOLD',
      'Choose one normal gem color; gold cannot be selected.',
    );
  }
  if (state.bank[color] < 4) {
    return failure(
      'TAKE_SAME_BANK',
      `At least four ${color} tokens must be in the bank.`,
    );
  }

  const next = cloneState(state);
  next.bank[color] -= 2;
  next.players[playerID].tokens[color] += 2;
  addLog(
    next,
    'tokens',
    `${playerLabel(playerID)} took two ${color} tokens.`,
    { key: 'same', values: { playerID, color } },
  );
  resolveAfterMainAction(next, playerID);
  return success(next);
};

const reserveMarket = (
  state: SplendorState,
  playerID: PlayerID,
  tier: Tier,
  cardID: string,
): RuleResult<SplendorState> => {
  if (state.players[playerID].reservedCards.length >= 3) {
    return failure(
      'RESERVE_LIMIT',
      'You may not hold more than three reserved cards.',
    );
  }
  if (
    !isTier(tier) ||
    typeof cardID !== 'string' ||
    !state.market[tier]?.includes(cardID)
  ) {
    return failure(
      'RESERVE_MARKET_MISSING',
      'That card is no longer in the market.',
    );
  }
  const card = getCard(cardID);
  if (!card || card.tier !== tier) {
    return failure('CARD_UNKNOWN', 'Card data is invalid.');
  }

  const next = cloneState(state);
  const slotIndex = next.market[tier].indexOf(cardID);
  if (slotIndex < 0) {
    return failure('RESERVE_MARKET_MISSING', 'That card is no longer in the market.');
  }
  next.market[tier][slotIndex] = null;
  next.players[playerID].reservedCards.push({
    cardId: cardID,
    tier,
    source: 'market',
  });
  const replacementCardId = refillMarketSlot(next, tier, slotIndex);
  if (next.bank.gold > 0) {
    next.bank.gold -= 1;
    next.players[playerID].tokens.gold += 1;
  }
  addLog(
    next,
    'reserve',
    `${playerLabel(playerID)} reserved public card ${cardID}.`,
    { key: 'reservePublic', values: { playerID, card: cardID } },
    {
      type: 'market-card',
      action: 'reserve',
      playerID,
      tier,
      slotIndex,
      cardId: cardID,
      replacementCardId,
    },
  );
  resolveAfterMainAction(next, playerID);
  return success(next);
};

const reserveDeck = (
  state: SplendorState,
  playerID: PlayerID,
  tier: Tier,
): RuleResult<SplendorState> => {
  if (state.players[playerID].reservedCards.length >= 3) {
    return failure(
      'RESERVE_LIMIT',
      'You may not hold more than three reserved cards.',
    );
  }
  if (!isTier(tier) || state.decks[tier]?.length === 0) {
    return failure(
      'RESERVE_EMPTY_DECK',
      'That development deck is empty.',
    );
  }

  const next = cloneState(state);
  const cardID = next.decks[tier].shift();
  if (!cardID) {
    return failure(
      'RESERVE_EMPTY_DECK',
      'That development deck is empty.',
    );
  }
  next.players[playerID].reservedCards.push({
    cardId: cardID,
    tier,
    source: 'deck',
  });
  if (next.bank.gold > 0) {
    next.bank.gold -= 1;
    next.players[playerID].tokens.gold += 1;
  }
  addLog(
    next,
    'reserve',
    `${playerLabel(playerID)} reserved a hidden tier ${tier} card.`,
    { key: 'reserveHidden', values: { playerID, tier } },
    { type: 'reserve-deck', playerID, tier },
  );
  resolveAfterMainAction(next, playerID);
  return success(next);
};

const purchase = (
  state: SplendorState,
  playerID: PlayerID,
  action: Extract<MainAction, { type: 'purchase' }>,
): RuleResult<SplendorState> => {
  const cardResult = findPurchasableCard(
    state,
    playerID,
    action.location,
  );
  if (!cardResult.ok) return failures(cardResult.errors);

  const payment = action.payment as TokenCounts;
  const analysis = analyzePayment(state, playerID, cardResult.value, payment);
  if (analysis.errors.length > 0) return failures(analysis.errors);

  const next = cloneState(state);
  for (const color of TOKEN_COLORS) {
    next.players[playerID].tokens[color] -= payment[color];
    next.bank[color] += payment[color];
  }
  next.players[playerID].purchasedCardIds.push(cardResult.value.id);

  if (action.location.source === 'market') {
    const slotIndex = next.market[action.location.tier].indexOf(
      action.location.cardId,
    );
    if (slotIndex < 0) {
      return failure('CARD_NOT_IN_MARKET', 'That card is no longer in the market.');
    }
    next.market[action.location.tier][slotIndex] = null;
    const replacementCardId = refillMarketSlot(
      next,
      action.location.tier,
      slotIndex,
    );
    addLog(
      next,
      'purchase',
      `${playerLabel(playerID)} purchased ${cardResult.value.id}.`,
      { key: 'purchase', values: { playerID, card: cardResult.value.id } },
      {
        type: 'market-card',
        action: 'purchase',
        playerID,
        tier: action.location.tier,
        slotIndex,
        cardId: cardResult.value.id,
        replacementCardId,
      },
    );
  } else {
    next.players[playerID].reservedCards = next.players[
      playerID
    ].reservedCards.filter(
      (reserved) => reserved.cardId !== action.location.cardId,
    );
    addLog(
      next,
      'purchase',
      `${playerLabel(playerID)} purchased ${cardResult.value.id}.`,
      { key: 'purchase', values: { playerID, card: cardResult.value.id } },
      {
        type: 'reserved-purchase',
        playerID,
        cardId: cardResult.value.id,
      },
    );
  }
  resolveAfterMainAction(next, playerID);
  return success(next);
};

export const applyMainAction = (
  state: SplendorState,
  playerID: PlayerID,
  currentPlayerID: PlayerID,
  action: MainAction,
): RuleResult<SplendorState> => {
  const actorError = validateActor(state, playerID, currentPlayerID);
  if (actorError) return actorError;
  if (state.pending) {
    return failure(
      'PENDING_RESOLUTION',
      state.pending.type === 'discard'
        ? 'Return excess tokens before taking another action.'
        : 'Choose a noble before taking another action.',
    );
  }
  if (!action || typeof action !== 'object') {
    return failure('ACTION_INVALID', 'Action is missing or invalid.');
  }

  switch (action.type) {
    case 'takeDifferent':
      return takeDifferent(state, playerID, action.colors);
    case 'takeSame':
      return takeSame(state, playerID, action.color);
    case 'reserveMarket':
      return reserveMarket(state, playerID, action.tier, action.cardId);
    case 'reserveDeck':
      return reserveDeck(state, playerID, action.tier);
    case 'purchase':
      return purchase(state, playerID, action);
    default:
      return failure('ACTION_INVALID', 'Action type is invalid.');
  }
};

export const applyDiscard = (
  state: SplendorState,
  playerID: PlayerID,
  currentPlayerID: PlayerID,
  returned: TokenCounts,
): RuleResult<SplendorState> => {
  const actorError = validateActor(state, playerID, currentPlayerID);
  if (actorError) return actorError;
  if (
    !state.pending ||
    state.pending.type !== 'discard' ||
    state.pending.playerID !== playerID
  ) {
    return failure('DISCARD_NOT_PENDING', 'No token return is pending.');
  }

  const errors: RuleError[] = [];
  let returnedTotal = 0;
  if (!returned || typeof returned !== 'object') {
    return failure('DISCARD_SHAPE', 'Token return is missing.');
  }
  for (const color of TOKEN_COLORS) {
    const amount = returned[color];
    if (!Number.isSafeInteger(amount) || amount < 0) {
      errors.push({
        code: 'DISCARD_AMOUNT',
        message: `${color} return must be a non-negative integer.`,
      });
      continue;
    }
    returnedTotal += amount;
    if (amount > state.players[playerID].tokens[color]) {
      errors.push({
        code: 'DISCARD_NOT_OWNED',
        message: `You do not own ${amount} ${color} tokens.`,
      });
    }
  }
  if (returnedTotal !== state.pending.count) {
    errors.push({
      code: 'DISCARD_EXACT',
      message: `Return exactly ${state.pending.count} token${
        state.pending.count === 1 ? '' : 's'
      }.`,
    });
  }
  if (errors.length > 0) return failures(errors);

  const next = cloneState(state);
  for (const color of TOKEN_COLORS) {
    next.players[playerID].tokens[color] -= returned[color];
    next.bank[color] += returned[color];
  }
  addLog(
    next,
    'discard',
    `${playerLabel(playerID)} returned ${formatTokenSelection(returned)}.`,
    { key: 'discard', values: { playerID, tokens: returned } },
  );
  next.pending = null;
  resolveNoblesOrComplete(next, playerID);
  return success(next);
};

export const applyNobleSelection = (
  state: SplendorState,
  playerID: PlayerID,
  currentPlayerID: PlayerID,
  nobleID: string,
): RuleResult<SplendorState> => {
  const actorError = validateActor(state, playerID, currentPlayerID);
  if (actorError) return actorError;
  if (
    !state.pending ||
    state.pending.type !== 'noble' ||
    state.pending.playerID !== playerID
  ) {
    return failure('NOBLE_NOT_PENDING', 'No noble selection is pending.');
  }
  if (
    typeof nobleID !== 'string' ||
    !state.pending.eligibleNobleIds.includes(nobleID) ||
    !getEligibleNobleIDs(state, playerID).includes(nobleID)
  ) {
    return failure(
      'NOBLE_INELIGIBLE',
      'That noble is not currently available to you.',
    );
  }

  const next = cloneState(state);
  next.pending = null;
  awardNoble(next, playerID, nobleID);
  completeTurn(next, playerID);
  return success(next);
};

export const suggestedDiscard = (
  state: SplendorState,
  playerID: PlayerID,
): TokenCounts => {
  const suggestion = emptyTokenCounts();
  const pending =
    state.pending?.type === 'discard' &&
    state.pending.playerID === playerID
      ? state.pending.count
      : 0;
  let remaining = pending;
  for (const color of [...TOKEN_COLORS].reverse()) {
    const amount = Math.min(
      state.players[playerID]?.tokens[color] ?? 0,
      remaining,
    );
    suggestion[color] = amount;
    remaining -= amount;
  }
  return suggestion;
};
