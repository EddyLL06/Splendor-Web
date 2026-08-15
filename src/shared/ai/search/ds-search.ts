/**
 * ds-search-v1: the Expert difficulty's pure depth-search + simulation
 * engine (no neural networks).
 *
 * Algorithm (PIMC-MCTS, optimized for the 2-player race to 15 prestige):
 *
 * 1. Determinization. The only hidden information is deck order and
 *    opponents' blind (deck) reservations. Each determinization samples a
 *    full legal `SplendorState` from the seeded RNG; a worker slice runs
 *    several determinizations and shares one wall-clock deadline.
 * 2. MCTS + PUCT. Inside each determinization, a search tree grows over
 *    legal actions for both players. Each node's player maximizes their own
 *    perspective of the value, so opponent nodes naturally play against us.
 *    Priors come from a cheap, hand-crafted action-quality score (no apply,
 *    no network). Leaf values come from the tuned linear evaluation, with
 *    terminal wins/losses at ±1 so the search drives for checkmate-like
 *    finishes instead of score.
 * 3. Endgame race rollouts. Once someone is at >= 12 prestige (or the tree
 *    is deep), leaves are extended with fast greedy rollouts to game end so
 *    the search simulates the actual race to 15 instead of a static eval.
 * 4. Aggregation. Root action statistics are summed across
 *    determinizations (and across worker threads, in the pool), then the
 *    move with the highest mean value is chosen; ties break by visit count
 *    and then actionKey, keeping decisions fully deterministic for the same
 *    (observation, seed).
 *
 * Never calls `Math.random()`; identical (observation, seed, budget inputs)
 * produce identical decisions.
 */

import { NORMAL_COLORS } from '../../constants/colors.js';
import { getCard, getNoble } from '../../data/gameData.js';
import {
  effectiveCostForCard,
  getBonuses,
  getScore,
  totalTokens,
} from '../../rules/selectors.js';
import { evaluateWithWeights } from '../evaluate.js';
import {
  extractFeatures,
  FEATURE_NAMES,
  type FeatureVector,
} from '../features.js';
import { NoLegalActionError } from '../errors.js';
import { determinize } from '../hidden-information.js';
import { HAND_TUNED_WEIGHTS } from '../models/default.js';
import {
  enumerateLegalActions,
  type AIActionCandidate,
} from '../legal-actions.js';
import { createSeededRNG, type SeededRNG } from '../seeded-rng.js';
import {
  applyFastMove,
  cloneStateFast,
  createFastSimulation,
  type FastSim,
} from './fast-sim.js';
import type {
  BotDecision,
  BoardContextView,
} from '../types.js';
import type {
  MainAction,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../../types/game.js';

// ---------------------------------------------------------------------------
// Tunable constants (exposed for the tuning pipeline and tests).
// ---------------------------------------------------------------------------

export const DS_SEARCH_CONSTANTS = {
  /** tanh input scale for linear-eval leaf values (smaller = more decisive). */
  EVAL_SCALE: 40,
  /** tanh input scale for one-ply q0 scores (tuned-eval magnitude). */
  Q0_SCALE: 15,
  /** PUCT exploration weight. */
  EXPLORE_C: 1.2,
  /** Prior softmax temperature. */
  PRIOR_TEMP: 3,
  /** Deep trees switch to endgame rollouts beyond this depth. */
  ROLLOUT_MIN_DEPTH: 24,
  /** Either player at/above this score also enables endgame rollouts. */
  ROLLOUT_ENDGAME_SCORE: 12,
  /** Hard cap on rollout length in plies. */
  ROLLOUT_MAX_PLIES: 80,
  /** Rollout move selection temperature (weighted pick, seeded). */
  ROLLOUT_PICK_TEMP: 2,
  /** Minimum simulations per determinization before deadline checks bite. */
  SIM_FLOOR: 8,
  /** Deadline is re-checked every this many simulations. */
  SIM_CHECK_INTERVAL: 8,
  /** Absolute safety cap on tree nodes (3 GB RAM is never approached). */
  MAX_NODES: 2_000_000,
} as const;

// ---------------------------------------------------------------------------
// Budget / input / result types.
// ---------------------------------------------------------------------------

export interface DsSearchBudget {
  deadlineEpochMs: number;
  /** Simulation cap for this worker slice (across all its determinizations). */
  maxSimulations: number;
  /** Total determinizations across all workers. */
  determinizations: number;
  /** First determinization index owned by this worker slice. */
  detIndex: number;
  /** Number of determinizations owned by this worker slice. */
  detCount: number;
}

export interface DsSearchDecisionInput {
  observation: Parameters<typeof determinize>[0];
  ctx: BoardContextView;
  seed: string;
  weights: Record<string, number>;
  budget: DsSearchBudget;
  memory?: import('../memory.js').ExpertMemorySnapshot;
}

export interface DsSearchRootStat {
  actionKey: string;
  visits: number;
  valueSum: number;
}

export interface DsSearchResult {
  decision: BotDecision;
  /** Aggregated root statistics for pool-side merging across workers. */
  stats: DsSearchRootStat[];
  /** actionKey -> move, so the merging side can recover the chosen move. */
  movesByKey: Record<string, import('../types.js').BotMove>;
}

// ---------------------------------------------------------------------------
// Cheap child-player prediction (no state clone, no apply).
//
// Must mirror `src/shared/rules/engine.ts` exactly:
//   resolveAfterMainAction: token overflow -> same-player discard pending;
//   otherwise resolveNoblesOrComplete: >=2 eligible -> same-player noble
//   pending; 0/1 eligible -> auto-award (1) and turn completes.
//   applyDiscard: same resolveNoblesOrComplete on unchanged bonuses.
//   applyNobleSelection: always completes the turn.
// ---------------------------------------------------------------------------

const ctxOfSim = (sim: FastSim): BoardContextView => ({
  currentPlayer: sim.currentPlayer,
  playOrder: sim.playOrder,
  playOrderPos: sim.playOrderPos,
});

const nextPlayerAfterTurn = (ctx: BoardContextView): PlayerID => {
  const pos = (ctx.playOrderPos + 1) % ctx.playOrder.length;
  return ctx.playOrder[pos];
};

const eligibleNobleCount = (
  state: SplendorState,
  playerID: PlayerID,
): number => {
  const bonuses = getBonuses(state, playerID);
  let count = 0;
  for (const nobleID of state.availableNobleIds) {
    const noble = getNoble(nobleID);
    if (
      noble &&
      NORMAL_COLORS.every(
        (color) => bonuses[color] >= noble.requirement[color],
      )
    ) {
      count += 1;
    }
  }
  return count;
};

const eligibleNobleCountWithBonus = (
  state: SplendorState,
  playerID: PlayerID,
  bonusColor: (typeof NORMAL_COLORS)[number],
): number => {
  const bonuses = getBonuses(state, playerID);
  bonuses[bonusColor] += 1;
  let count = 0;
  for (const nobleID of state.availableNobleIds) {
    const noble = getNoble(nobleID);
    if (
      noble &&
      NORMAL_COLORS.every(
        (color) => bonuses[color] >= noble.requirement[color],
      )
    ) {
      count += 1;
    }
  }
  return count;
};

/** Player who owns the decision node after `move` is applied. */
export const predictChildPlayer = (
  state: SplendorState,
  playerID: PlayerID,
  ctx: BoardContextView,
  move: import('../types.js').BotMove,
): PlayerID => {
  const next = nextPlayerAfterTurn(ctx);
  if (move.move === 'chooseNoble') return next;
  if (move.move === 'discardTokens') {
    // Discard leaves bonuses untouched; >=2 eligible nobles keep the turn.
    return eligibleNobleCount(state, playerID) >= 2 ? playerID : next;
  }
  const action = move.args[0] as MainAction;
  const player = state.players[playerID];
  switch (action.type) {
    case 'pass':
      return next;
    case 'takeSame': {
      const overflow = totalTokens(player.tokens) + 2 > 10;
      if (overflow) return playerID;
      return eligibleNobleCount(state, playerID) >= 2 ? playerID : next;
    }
    case 'takeDifferent': {
      const overflow = totalTokens(player.tokens) + action.colors.length > 10;
      if (overflow) return playerID;
      return eligibleNobleCount(state, playerID) >= 2 ? playerID : next;
    }
    case 'reserveMarket':
    case 'reserveDeck': {
      const overflow =
        totalTokens(player.tokens) + (state.bank.gold > 0 ? 1 : 0) > 10;
      if (overflow) return playerID;
      return eligibleNobleCount(state, playerID) >= 2 ? playerID : next;
    }
    case 'purchase': {
      let spent = 0;
      for (const amount of Object.values(action.payment)) spent += amount;
      const overflow = totalTokens(player.tokens) - spent > 10;
      if (overflow) return playerID;
      const card =
        action.location.source === 'market'
          ? getCard(action.location.cardId)
          : state.players[playerID].reservedCards.find(
              (reserved) => reserved.cardId === action.location.cardId,
            )
            ? getCard(action.location.cardId)
            : undefined;
      if (card) {
        return eligibleNobleCountWithBonus(state, playerID, card.bonus) >= 2
          ? playerID
          : next;
      }
      return next;
    }
    default:
      return next;
  }
};

// ---------------------------------------------------------------------------
// Cheap action-quality priors (state-only, no apply). Uses one shared
// "token usefulness" pass per expansion.
// ---------------------------------------------------------------------------

type Usefulness = Record<
  (typeof NORMAL_COLORS)[number] | 'gold',
  number
>;

const tokenUsefulness = (
  state: SplendorState,
  playerID: PlayerID,
): Usefulness => {
  const values: Usefulness = {
    white: 0,
    blue: 0,
    green: 0,
    red: 0,
    black: 0,
    gold: 2,
  };
  const consider = (cardID: string | null | undefined): void => {
    if (!cardID) return;
    const card = getCard(cardID);
    if (!card) return;
    const effective = effectiveCostForCard(state, playerID, card);
    for (const color of NORMAL_COLORS) {
      values[color] += Math.min(effective[color], 2);
    }
  };
  for (const tier of [1, 2, 3] as const) {
    for (const cardID of state.market[tier]) consider(cardID);
  }
  for (const reserved of state.players[playerID]?.reservedCards ?? []) {
    consider(reserved.cardId);
  }
  return values;
};

const quickActionScore = (
  state: SplendorState,
  playerID: PlayerID,
  ctx: BoardContextView,
  candidate: AIActionCandidate,
  baseEval: number,
  baseFeatures: import('../features.js').FeatureVector,
  weights: Record<string, number>,
): number => {
  /**
   * One-ply value of the candidate under the TUNED linear model, computed
   * as feature deltas on top of the node's precomputed feature vector —
   * no state apply, no clone. The handful of market-dependent features
   * (affordableCount, tempo, marketValue, noble threats) keep their
   * current values; their deltas are second-order for move ranking.
   */
  const deltas: Partial<import('../features.js').FeatureVector> = {};
  const add = (name: keyof typeof deltas, value: number): void => {
    deltas[name] = (deltas[name] ?? 0) + value;
  };

  const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

  if (candidate.move.move === 'chooseNoble') {
    const noble = getNoble(candidate.move.args[0]);
    const points = noble?.points ?? 0;
    add('score', points / 15);
    add('leaderGap', points / 15);
    add('distanceTo15', -points / 15);
    add('nobleCount', 1 / 5);
  } else if (candidate.move.move === 'discardTokens') {
    const returned = candidate.move.args[0] as TokenCounts;
    let total = 0;
    for (const amount of Object.values(returned)) total += amount;
    add('tokensTotal', -total / 10);
    const currentWaste =
      state.pending?.type === 'discard' ? clamp01(state.pending.count / 5) : 0;
    add('waste', -currentWaste);
  } else {
    const action = candidate.move.args[0] as MainAction;
    switch (action.type) {
      case 'purchase': {
        const card =
          action.location.source === 'market'
            ? getCard(action.location.cardId)
            : getCard(action.location.cardId);
        if (card) {
          add('score', card.points / 15);
          add('leaderGap', card.points / 15);
          add('distanceTo15', -card.points / 15);
          add(`bonus${capColor(card.bonus)}`, 1 / 10);
          add('purchasedCount', 1 / 25);
          add('tiebreakCards', 1 / 25);
        }
        let spent = 0;
        for (const amount of Object.values(action.payment)) spent += amount;
        add('tokensTotal', -spent / 10);
        add('gold', -action.payment.gold / 5);
        break;
      }
      case 'reserveMarket':
      case 'reserveDeck': {
        const goldGain = state.bank.gold > 0 ? 1 : 0;
        add('tokensTotal', goldGain / 10);
        add('gold', goldGain / 5);
        add('reservedSlots', 1 / 3);
        if (
          totalTokens(state.players[playerID]?.tokens ?? emptyTokens()) +
            goldGain >
          10
        ) {
          add('waste', 1);
        }
        break;
      }
      case 'takeSame': {
        add('tokensTotal', 2 / 10);
        if (
          totalTokens(state.players[playerID]?.tokens ?? emptyTokens()) + 2 >
          10
        ) {
          add('waste', 1);
        }
        break;
      }
      case 'takeDifferent': {
        const count = action.colors.length;
        add('tokensTotal', count / 10);
        if (
          totalTokens(state.players[playerID]?.tokens ?? emptyTokens()) +
            count >
          10
        ) {
          add('waste', 1);
        }
        break;
      }
      case 'pass':
        break;
      default:
        break;
    }
  }

  let value = baseEval;
  for (const [name, delta] of Object.entries(deltas)) {
    const feature = baseFeatures[name as keyof typeof baseFeatures] ?? 0;
    const target = clamp01(feature + (delta as number));
    value += (target - feature) * (weights[name] ?? 0);
  }
  void ctx;
  return value;
};

const capColor = (color: string): 'White' | 'Blue' | 'Green' | 'Red' | 'Black' =>
  (color.charAt(0).toUpperCase() + color.slice(1)) as
    | 'White'
    | 'Blue'
    | 'Green'
    | 'Red'
    | 'Black';

const emptyTokens = (): TokenCounts => ({
  white: 0,
  blue: 0,
  green: 0,
  red: 0,
  black: 0,
  gold: 0,
});

const priorsFor = (
  state: SplendorState,
  playerID: PlayerID,
  ctx: BoardContextView,
  candidates: AIActionCandidate[],
  weights: Record<string, number>,
): { priors: number[]; scores: number[] } => {
  const baseFeatures = extractFeatures(state, playerID);
  let baseEval = 0;
  for (const name of FEATURE_NAMES) {
    baseEval += baseFeatures[name] * (weights[name] ?? 0);
  }
  const scores = candidates.map((candidate) =>
    quickActionScore(
      state,
      playerID,
      ctx,
      candidate,
      baseEval,
      baseFeatures,
      weights,
    ),
  );
  const min = Math.min(...scores);
  const temp = DS_SEARCH_CONSTANTS.PRIOR_TEMP;
  const shifted = scores.map((score) => Math.exp((score - min) / temp));
  const total = shifted.reduce((sum, value) => sum + value, 0);
  return {
    priors: shifted.map((value) => value / (total || 1)),
    scores,
  };
};

/**
 * Cheap rollout move score (state-only, no apply): prefers point purchases,
 * then useful token gathering. Only used inside greedy rollouts.
 */
const rolloutScore = (
  state: SplendorState,
  playerID: PlayerID,
  candidate: AIActionCandidate,
  usefulness: Usefulness,
): number => {
  if (candidate.move.move === 'discardTokens') {
    const returned = candidate.move.args[0] as TokenCounts;
    let penalty = 0;
    for (const color of NORMAL_COLORS) {
      penalty += usefulness[color] * returned[color];
    }
    return 60 - penalty * 2.5;
  }
  if (candidate.move.move === 'chooseNoble') {
    const noble = getNoble(candidate.move.args[0]);
    return 200 + (noble?.points ?? 0) * 10;
  }
  const action = candidate.move.args[0] as MainAction;
  switch (action.type) {
    case 'purchase': {
      const card =
        action.location.source === 'market'
          ? getCard(action.location.cardId)
          : state.players[playerID].reservedCards.some(
                (reserved) => reserved.cardId === action.location.cardId,
              )
            ? getCard(action.location.cardId)
            : undefined;
      return (
        24 +
        (card?.points ?? 0) * 20 +
        (card?.tier ?? 2) * 4 -
        action.payment.gold * 8
      );
    }
    case 'reserveMarket': {
      const card = getCard(action.cardId);
      return 18 + (card?.points ?? 0) * 7 + (card?.tier === 3 ? 4 : 0);
    }
    case 'reserveDeck':
      return 14 + action.tier * 2 + (action.tier === 3 ? 5 : 0);
    case 'takeDifferent': {
      let score = 12;
      for (const color of action.colors) {
        if (color !== 'gold') score += usefulness[color] * 2.5;
      }
      return score;
    }
    case 'takeSame':
      return action.color === 'gold'
        ? 4
        : 10 + usefulness[action.color] * 4.5;
    case 'pass':
      return 2;
    default:
      return 0;
  }
};

// ---------------------------------------------------------------------------
// MCTS tree.
// ---------------------------------------------------------------------------

interface DsNode {
  action: AIActionCandidate | null;
  playerID: PlayerID;
  depth: number;
  visits: number;
  valueSum: number;
  /** One-ply eval prior used as the Q estimate before the first real visit. */
  q0: number;
  prior: number;
  children: DsNode[] | null;
}

const applyMove = (
  sim: FastSim,
  playerID: PlayerID,
  move: import('../types.js').BotMove,
): boolean => applyFastMove(sim, playerID, move);

const terminalValue = (state: SplendorState, botID: PlayerID): number => {
  const winners = state.result?.winners ?? [];
  if (winners.includes(botID)) {
    return winners.length === 1 ? 1 : 0;
  }
  return -1;
};

const leafValue = (
  state: SplendorState,
  botID: PlayerID,
  weights: Record<string, number>,
): number => {
  if (state.result) return terminalValue(state, botID);
  const raw = evaluateWithWeights(state, botID, weights);
  return Math.tanh(raw / DS_SEARCH_CONSTANTS.EVAL_SCALE);
};

const maxScoreOf = (state: SplendorState): number =>
  Math.max(0, ...state.playerOrder.map((playerID) => getScore(state, playerID)));

/**
 * Fast greedy rollout to game end (or the ply cap) with seeded weighted
 * picks. Returns terminal value when the game ends, else the eval value.
 */
const rollout = (
  sim: FastSim,
  botID: PlayerID,
  weights: Record<string, number>,
  rng: SeededRNG,
  deadlineEpochMs: number,
): number => {
  let plies = 0;
  while (
    plies < DS_SEARCH_CONSTANTS.ROLLOUT_MAX_PLIES &&
    performance.now() < deadlineEpochMs
  ) {
    plies += 1;
    const playerID = sim.currentPlayer;
    const candidates = enumerateLegalActions(sim.G, playerID, playerID);
    if (candidates.length === 0) break;
    const usefulness = tokenUsefulness(sim.G, playerID);
    const scores = candidates.map((candidate) =>
      Math.max(
        0.01,
        Math.exp(
          rolloutScore(sim.G, playerID, candidate, usefulness) /
            DS_SEARCH_CONSTANTS.ROLLOUT_PICK_TEMP,
        ),
      ),
    );
    const total = scores.reduce((sum, value) => sum + value, 0);
    let roll = rng.next() * total;
    let chosen = candidates[candidates.length - 1];
    for (let index = 0; index < candidates.length; index += 1) {
      roll -= scores[index];
      if (roll <= 0) {
        chosen = candidates[index];
        break;
      }
    }
    if (!applyMove(sim, playerID, chosen.move)) {
      return leafValue(sim.G, botID, weights);
    }
    if (sim.G.result) return terminalValue(sim.G, botID);
  }
  return leafValue(sim.G, botID, weights);
};

interface MctsStats {
  sims: number;
  nodes: number;
  timedOut: boolean;
}

const runMcts = (
  rootState: SplendorState,
  ctx: BoardContextView,
  botID: PlayerID,
  weights: Record<string, number>,
  deadlineEpochMs: number,
  maxSimulations: number,
  simSeed: string,
): { root: DsNode; stats: MctsStats } => {
  const root: DsNode = {
    action: null,
    playerID: ctx.currentPlayer,
    depth: 0,
    visits: 0,
    valueSum: 0,
    q0: 0,
    prior: 1,
    children: null,
  };
  let nodes = 1;
  let sims = 0;
  let timedOut = false;

  const selectChild = (node: DsNode): DsNode => {
    const perspective = node.playerID === botID ? 1 : -1;
    const logParent = Math.log(node.visits + 1);
    let best: DsNode | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const child of node.children ?? []) {
      const q =
        child.visits > 0
          ? child.valueSum / child.visits
          : child.q0;
      const u =
        DS_SEARCH_CONSTANTS.EXPLORE_C *
        child.prior *
        Math.sqrt(logParent / (1 + child.visits));
      const score = perspective * q + u;
      if (score > bestScore) {
        bestScore = score;
        best = child;
      }
    }
    if (!best) throw new Error('MCTS selectChild on a node with no children.');
    return best;
  };

  const expand = (node: DsNode, sim: FastSim): void => {
    // The authoritative sim knows whose decision this is; self-heal if the
    // cheap child-player prediction ever drifts, so a subtree can never
    // silently dead-end on a wrong actor.
    const actor = sim.currentPlayer;
    if (node.playerID !== actor) node.playerID = actor;
    const candidates = enumerateLegalActions(sim.G, actor, actor);
    const { priors, scores } = priorsFor(
      sim.G,
      actor,
      ctxOfSim(sim),
      candidates,
      weights,
    );
    const nodeCtx = ctxOfSim(sim);
    node.children = candidates.map((action, index) => ({
      action,
      playerID: predictChildPlayer(sim.G, actor, nodeCtx, action.move),
      depth: node.depth + 1,
      visits: 0,
      valueSum: 0,
      q0: Math.tanh(
        (scores[index] ?? 0) / DS_SEARCH_CONSTANTS.Q0_SCALE,
      ),
      prior: priors[index] ?? 0,
      children: null,
    }));
    nodes += candidates.length;
  };

  const backup = (path: DsNode[], value: number): void => {
    for (const node of path) {
      node.visits += 1;
      node.valueSum += value;
    }
  };

  const shouldRollout = (sim: FastSim, depth: number): boolean =>
    depth >= DS_SEARCH_CONSTANTS.ROLLOUT_MIN_DEPTH ||
    maxScoreOf(sim.G) >= DS_SEARCH_CONSTANTS.ROLLOUT_ENDGAME_SCORE;

  while (
    sims < maxSimulations &&
    nodes < DS_SEARCH_CONSTANTS.MAX_NODES
  ) {
    if (
      sims >= DS_SEARCH_CONSTANTS.SIM_FLOOR &&
      sims % DS_SEARCH_CONSTANTS.SIM_CHECK_INTERVAL === 0 &&
      performance.now() >= deadlineEpochMs
    ) {
      timedOut = true;
      break;
    }
    const sim = createFastSimulation(cloneStateFast(rootState), ctx);
    const path: DsNode[] = [];
    let node = root;
    let value: number;
    for (;;) {
      if (sim.G.result !== null) {
        value = terminalValue(sim.G, botID);
        break;
      }
      if (node.children === null) {
        expand(node, sim);
        path.push(node);
        if (node.children!.length === 0) {
          // No legal action at this node: treat it as a leaf.
          value = leafValue(sim.G, botID, weights);
          break;
        }
        if (shouldRollout(sim, node.depth)) {
          const rng = createSeededRNG(`${simSeed}:roll:${sims}`);
          value = rollout(sim, botID, weights, rng, deadlineEpochMs);
        } else {
          // Static tuned-model evaluation of the leaf position; the tree's
          // depth adds the tactical lookahead on top.
          value = leafValue(sim.G, botID, weights);
        }
        break;
      }
      const child = selectChild(node);
      path.push(node);
      if (!applyMove(sim, sim.currentPlayer, child.action!.move)) {
        // Defensive: an illegal child means prediction drifted; evaluate the
        // parent so the search stays safe and legal.
        value = leafValue(sim.G, botID, weights);
        break;
      }
      node = child;
      if (sim.G.result !== null) {
        // The action ended the game: credit the terminal node too, so its
        // Q value reflects the actual outcome instead of staying unvisited.
        path.push(node);
        value = terminalValue(sim.G, botID);
        break;
      }
    }
    backup(path, value);
    sims += 1;
  }

  return { root, stats: { sims, nodes, timedOut } };
};

// ---------------------------------------------------------------------------
// Decision entry: determinization loop + aggregation.
// ---------------------------------------------------------------------------

const aggregate = (
  agg: Map<string, { visits: number; valueSum: number }>,
  root: DsNode,
): void => {
  for (const child of root.children ?? []) {
    if (child.action === null || child.visits === 0) continue;
    const entry = agg.get(child.action.actionKey);
    if (entry) {
      entry.visits += child.visits;
      entry.valueSum += child.valueSum;
    } else {
      agg.set(child.action.actionKey, {
        visits: child.visits,
        valueSum: child.valueSum,
      });
    }
  }
};

export const computeDsSearchDecision = (
  input: DsSearchDecisionInput,
): DsSearchResult => {
  const { observation, ctx, seed, weights: rawWeights, budget } = input;
  const weights =
    rawWeights && Object.keys(rawWeights).length > 0
      ? rawWeights
      : ({ ...HAND_TUNED_WEIGHTS } as Record<string, number>);
  const startedAt = performance.now();
  const botID = observation.playerID;
  const detCount = Math.max(1, budget.detCount ?? budget.determinizations);
  const detIndex = budget.detIndex ?? 0;
  const maxSimulations = Math.max(1, budget.maxSimulations);
  const deadline = budget.deadlineEpochMs;

  const agg = new Map<string, { visits: number; valueSum: number }>();
  const movesByKey = new Map<string, import('../types.js').BotMove>();
  let totalSims = 0;
  let timedOut = false;

  for (let det = detIndex; det < detIndex + detCount; det += 1) {
    const remaining = maxSimulations - totalSims;
    if (remaining <= 0) {
      timedOut = true;
      break;
    }
    const rng = createSeededRNG(`ds:${seed}:${det}`);
    const rootState = determinize(observation, rng);
    const { root, stats } = runMcts(
      rootState,
      ctx,
      botID,
      weights,
      deadline,
      remaining,
      `ds:${seed}:${det}`,
    );
    totalSims += stats.sims;
    if (stats.timedOut) timedOut = true;
    aggregate(agg, root);
    for (const child of root.children ?? []) {
      if (child.action) movesByKey.set(child.action.actionKey, child.action.move);
    }
    if (performance.now() >= deadline) {
      timedOut = true;
      break;
    }
  }

  if (agg.size === 0) {
    throw new NoLegalActionError(botID, 0);
  }

  const ranked = [...agg.entries()].sort((left, right) => {
    const leftMean = left[1].valueSum / left[1].visits;
    const rightMean = right[1].valueSum / right[1].visits;
    return (
      rightMean - leftMean ||
      right[1].visits - left[1].visits ||
      left[0].localeCompare(right[0])
    );
  });
  const bestKey = ranked[0][0];
  const move = movesByKey.get(bestKey);
  if (!move) throw new NoLegalActionError(botID, 0);

  const decision: BotDecision = {
    move,
    modelVersion: 'ai-kernel-ds-v1.0.0',
    policy: 'ds-search-v1',
    seed,
    nodesVisited: totalSims,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    timedOut,
    fallbackLevel: timedOut ? 1 : 0,
  };

  return {
    decision,
    stats: ranked.map(([actionKey, entry]) => ({
      actionKey,
      visits: entry.visits,
      valueSum: entry.valueSum,
    })),
    movesByKey: Object.fromEntries(movesByKey),
  };
};
