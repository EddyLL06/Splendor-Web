/**
 * Expert difficulty: iterated Hard-style rounds (v3).
 *
 * Round 1 mirrors the Hard beam exactly: rank legal moves by one ply, keep
 * the top few, complete each own turn, let opponents answer with Normal
 * turns, and score the resulting position with the tuned model. Round 2 then
 * re-runs that same Hard-quality search for the Bot's NEXT turn inside each
 * surviving line, so the Expert effectively plans two of its own turns with
 * search-strength moves instead of one-ply replies. The extra lookahead is
 * what makes it stronger than Hard; the leaf value stays the tuned model
 * (plus a tiny public match-memory recency signal) so the search does not
 * inherit ad-hoc eval bias.
 *
 * Deterministic per (observation, seed, memory); hidden-information
 * invariant; deadline/node caps return best-so-far.
 */

import {
  extractFeatures,
  FEATURE_NAMES,
} from '../features.js';
import { evaluateWithWeights } from '../evaluate.js';
import { getBonuses, getScore, analyzePayment } from '../../rules/selectors.js';
import { getCard, getNoble } from '../../data/gameData.js';
import { determinize } from '../hidden-information.js';
import { enumerateLegalActions, type AIActionCandidate } from '../legal-actions.js';
import { NoLegalActionError } from '../errors.js';
import { createSeededRNG } from '../seeded-rng.js';
import { chooseNormalMove } from '../policy-normal.js';
import type { ExpertMemorySnapshot } from '../memory.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
  type SimulationState,
} from '../simulate.js';
import type { HardDecisionInput } from './beam.js';
import type {
  BotDecision,
  BoardContextView,
  SearchBudget,
} from '../types.js';
import type {
  MainAction,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../../types/game.js';

const cloneState = (state: SplendorState): SplendorState =>
  JSON.parse(JSON.stringify(state)) as SplendorState;

const ctxOf = (sim: SimulationState): BoardContextView => ({
  currentPlayer: sim.currentPlayer,
  playOrder: sim.playOrder,
  playOrderPos: sim.playOrderPos,
});

/**
 * Small, tunable extras on top of the linear model. Kept minimal: round-1/2
 * ablation showed large event terms distort the search (reserve hoarding).
 */
export const EXPERT_EVAL_WEIGHTS = {
  recentReservePenalty: 1,
  opponentAffordablePointPenalty: 0.4,
  opponentGoldPenalty: 0.6,
  opponentTier3ReservePenalty: 1,
  opponentNobleProgressPenalty: 2,
  /** Cancel the shared model's tempo term, which penalizes affordability. */
  tempoCancel: 3,
  /** Reward engine buying power explicitly. */
  affordableBonus: 4,
  /** Soften snapshot token-hoarding bias. */
  tokenHoardingPenalty: 0.6,
} as const;

/**
 * Expert-specific eval extras may be injected through reserved weight keys
 * (used by the expert tuning pipeline). Absent keys fall back to the
 * constants above, so production model files stay unchanged.
 */
const expertExtras = (
  weights: Record<string, number>,
): {
  tempoCancel: number;
  affordableBonus: number;
  tokenHoardingPenalty: number;
  bonusCountBonus: number;
} => ({
  tempoCancel: weights.__x_tempoCancel ?? EXPERT_EVAL_WEIGHTS.tempoCancel,
  affordableBonus:
    weights.__x_affordableBonus ?? EXPERT_EVAL_WEIGHTS.affordableBonus,
  tokenHoardingPenalty:
    weights.__x_tokenHoardingPenalty ??
    EXPERT_EVAL_WEIGHTS.tokenHoardingPenalty,
  bonusCountBonus: weights.__x_bonusCountBonus ?? 0,
});

const averageNobleCloseness = (
  state: SplendorState,
  playerID: PlayerID,
): number => {
  if (!state.players[playerID]) return 0;
  const bonuses = getBonuses(state, playerID);
  const scores: number[] = [];
  for (const nobleID of state.availableNobleIds) {
    const noble = getNoble(nobleID);
    if (!noble) continue;
    let achieved = 0;
    let required = 0;
    for (const [color, count] of Object.entries(noble.requirement) as [
      'white' | 'blue' | 'green' | 'red' | 'black',
      number,
    ][]) {
      required += count;
      achieved += Math.min(bonuses[color], count);
    }
    if (required > 0) scores.push(achieved / required);
  }
  return scores.length === 0
    ? 0
    : scores.reduce((sum, value) => sum + value, 0) / scores.length;
};

/**
 * Leaf-only opponent pressure: how dangerous the table is for the Bot right
 * now. Computed from the leaf state (never accumulated), so it rewards lines
 * that slow opponents without biasing every later evaluation.
 */
const opponentPressure = (
  state: SplendorState,
  playerID: PlayerID,
): number => {
  const w = EXPERT_EVAL_WEIGHTS;
  let pressure = 0;
  for (const other of state.playerOrder) {
    if (other === playerID) continue;
    const player = state.players[other];
    if (!player) continue;
    pressure += player.tokens.gold * w.opponentGoldPenalty;
    for (const tier of [1, 2, 3] as const) {
      for (const cardID of state.market[tier]) {
        if (cardID === null) continue;
        const card = getCard(cardID);
        if (
          card &&
          analyzePayment(state, other, card).errors.length === 0
        ) {
          pressure += card.points * w.opponentAffordablePointPenalty;
        }
      }
    }
    for (const reserved of player.reservedCards) {
      if (reserved.tier === 3) {
        pressure += w.opponentTier3ReservePenalty;
      }
    }
    pressure +=
      averageNobleCloseness(state, other) * w.opponentNobleProgressPenalty;
  }
  return pressure;
};

const evaluateLeaf = (
  state: SplendorState,
  playerID: PlayerID,
  weights: Record<string, number>,
  memory?: ExpertMemorySnapshot,
): number => {
  if (state.result) {
    return state.result.winners.includes(playerID) ? 1_000_000 : -1_000_000;
  }
  const features = extractFeatures(state, playerID);
  let value = 0;
  for (const name of FEATURE_NAMES) {
    value += features[name] * (weights[name] ?? 0);
  }
  const extras = expertExtras(weights);
  value += features.tempo * extras.tempoCancel;
  value += features.affordableCount * extras.affordableBonus;
  value -= features.tokensTotal * extras.tokenHoardingPenalty;
  value +=
    (features.bonusWhite +
      features.bonusBlue +
      features.bonusGreen +
      features.bonusRed +
      features.bonusBlack) *
    extras.bonusCountBonus;
  const w = EXPERT_EVAL_WEIGHTS;
  value -= opponentPressure(state, playerID);
  if (memory) {
    for (const other of state.playerOrder) {
      if (other === playerID) continue;
      const seen = memory.players[other];
      if (
        seen &&
      seen.lastAction === 'reserve' &&
      seen.lastActionTurnsAgo === 0
      ) {
        value -= w.recentReservePenalty;
      }
    }
  }
  return value;
};

const applyCandidate = (
  sim: SimulationState,
  playerID: PlayerID,
  candidate: AIActionCandidate,
): boolean => {
  const [argument] = candidate.move.args;
  const result =
    candidate.move.move === 'mainAction'
      ? applySimulationMainAction(sim, playerID, argument as MainAction)
      : candidate.move.move === 'discardTokens'
        ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
        : applySimulationNoble(sim, playerID, argument as string);
  return result.ok;
};

/** Applies one candidate and completes the player's own resolution chain. */
const applyCandidateFullTurn = (
  sim: SimulationState,
  playerID: PlayerID,
  candidate: AIActionCandidate,
  weights: Record<string, number>,
  seed: string,
  step: number,
): boolean => {
  if (!applyCandidate(sim, playerID, candidate)) return false;
  let guard = 0;
  while (
    sim.G.result === null &&
    sim.G.pending !== null &&
    sim.G.pending.playerID === playerID &&
    guard < 4
  ) {
    guard += 1;
    const reply = chooseNormalMove(
      sim.G,
      playerID,
      ctxOf(sim),
      `${seed}:resolve:${step}:${guard}`,
      weights,
    );
    if (!applyCandidate(sim, playerID, reply)) return false;
  }
  return sim.G.pending === null || sim.G.pending.playerID !== playerID;
};

/** One full turn for the current (opponent) player. */
const playOneFullTurn = (
  sim: SimulationState,
  playerID: PlayerID,
  weights: Record<string, number>,
  seed: string,
  step: number,
  hardModel: boolean,
  memory: ExpertMemorySnapshot | undefined,
  deadline: number,
  nodeBudget: { used: number; max: number },
  hardLayers: number,
): void => {
  let guard = 0;
  while (sim.G.result === null && guard < 8) {
    guard += 1;
    let candidate: AIActionCandidate;
    if (hardModel) {
      const round = runRound(
        sim.G,
        ctxOf(sim),
        playerID,
        weights,
        seed,
        step * 8 + guard,
        memory,
        3,
        nodeBudget,
        deadline,
        hardLayers - 1,
      );
      if (round.length === 0) {
        candidate = chooseNormalMove(
          sim.G,
          playerID,
          ctxOf(sim),
          `${seed}:opp:${step}:${guard}`,
          weights,
        );
      } else {
        candidate = round[0].candidate;
      }
    } else {
      candidate = chooseNormalMove(
        sim.G,
        playerID,
        ctxOf(sim),
        `${seed}:opp:${step}:${guard}`,
        weights,
      );
    }
    if (!applyCandidate(sim, playerID, candidate)) {
      throw new Error(
        `Expert search opponent produced illegal move: ${playerID}`,
      );
    }
    if (performance.now() >= deadline) break;
    if (sim.currentPlayer !== playerID) return;
    if (sim.G.pending === null && sim.G.turnReady) return;
  }
};

const playOpponentsUntilBot = (
  sim: SimulationState,
  botID: PlayerID,
  weights: Record<string, number>,
  seed: string,
  step: number,
  memory: ExpertMemorySnapshot | undefined,
  deadline: number,
  nodeBudget: { used: number; max: number },
  hardLayers = 1,
): void => {
  const scores = sim.G.playerOrder.map((playerID) =>
    getScore(sim.G, playerID),
  );
  const leader = Math.max(0, ...scores);
  let guard = 0;
  while (
    sim.G.result === null &&
    sim.currentPlayer !== botID &&
    guard < sim.playOrder.length * 4
  ) {
    guard += 1;
    // Model competitive opponents (within 3 points of the leader) as
    // Hard-lite searchers; weaker opponents stay cheap Normal.
    // Hard-lite opponent modeling: used only where the caller asks for it
    // (final leaf responses); intermediate opponents stay Normal.
    const competitive =
      hardLayers > 0 &&
      (sim.G.playerOrder.length === 2 ||
        getScore(sim.G, sim.currentPlayer) >= leader - 3);
    playOneFullTurn(
      sim,
      sim.currentPlayer,
      weights,
      seed,
      step,
      competitive,
      memory,
      deadline,
      nodeBudget,
      hardLayers,
    );
  }
};

interface RankedRound {
  candidate: AIActionCandidate;
  /** Sim after the candidate's own full turn and opponents' replies. */
  sim: SimulationState;
  /** Position after the Bot's one-ply reply (Hard's round-1 leaf). */
  replySim: SimulationState;
  score: number;
}

/**
 * One Hard-quality round for `playerID` (who must be on turn): rank legal
 * moves, complete each own turn, play opponents, reply one ply, score.
 * Returns the ranked rounds for the caller to extend.
 */
const runRound = (
  state: SplendorState,
  ctx: BoardContextView,
  playerID: PlayerID,
  weights: Record<string, number>,
  seed: string,
  step: number,
  memory: ExpertMemorySnapshot | undefined,
  topN = 5,
  nodeBudget: { used: number; max: number } = { used: 0, max: Number.MAX_SAFE_INTEGER },
  deadlineEpochMs = Number.MAX_SAFE_INTEGER,
  hardLayers = 1,
): RankedRound[] => {
  const candidates = enumerateLegalActions(state, playerID, ctx.currentPlayer);
  const onePly: { candidate: AIActionCandidate; sim: SimulationState; score: number }[] = [];
  for (const candidate of candidates) {
    if (
      nodeBudget.used >= nodeBudget.max ||
      performance.now() >= deadlineEpochMs
    ) {
      break;
    }
    const sim = createSimulation(cloneState(state), ctx);
    if (!applyCandidateFullTurn(sim, playerID, candidate, weights, seed, step)) {
      continue;
    }
    nodeBudget.used += 1;
    onePly.push({
      candidate,
      sim,
      score: evaluateWithWeights(sim.G, playerID, weights),
    });
  }
  onePly.sort(
    (left, right) =>
      right.score - left.score ||
      left.candidate.actionKey.localeCompare(right.candidate.actionKey),
  );

  const ranked: RankedRound[] = [];
  for (const entry of onePly.slice(0, topN)) {
    if (
      nodeBudget.used >= nodeBudget.max ||
      performance.now() >= deadlineEpochMs
    ) {
      break;
    }
    const replySim = createSimulation(cloneState(entry.sim.G), ctxOf(entry.sim));
    playOpponentsUntilBot(
      replySim,
      playerID,
      weights,
      seed,
      step,
      memory,
      deadlineEpochMs,
      nodeBudget,
      hardLayers,
    );
    if (replySim.G.result === null && replySim.currentPlayer === playerID) {
      const reply = chooseNormalMove(
        replySim.G,
        playerID,
        ctxOf(replySim),
        `${seed}:reply:${step}`,
        weights,
      );
      applyCandidateFullTurn(replySim, playerID, reply, weights, seed, step);
    }
    nodeBudget.used += 1;
    ranked.push({
      candidate: entry.candidate,
      sim: entry.sim,
      replySim,
      score: evaluateLeaf(replySim.G, playerID, weights, memory),
    });
  }
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      left.candidate.actionKey.localeCompare(right.candidate.actionKey),
  );
  return ranked;
};

export const computeExpertDecision = (
  input: HardDecisionInput & {
    maxSimulations?: number;
    maxDeterminizations?: number;
    memory?: ExpertMemorySnapshot;
  },
): BotDecision => {
  const { observation, ctx, seed, weights, budget, memory } = input;
  const startedAt = performance.now();
  const rng = createSeededRNG(`expert:${seed}`);
  const fullState = determinize(observation, rng);
  const playerID = observation.playerID;

  const deadline = budget.deadlineEpochMs;
  const nodeBudget = {
    used: 0,
    max: Math.max(1, budget.maxNodes || 1200),
  };
  const maxSimulations = Math.max(1, input.maxSimulations ?? 400);
  let timedOut = false;

  // Round 1: Hard-quality ranking of the current move.
  const roundOne = runRound(
    fullState,
    ctx,
    playerID,
    weights,
    seed,
    1,
    memory,
    5,
    nodeBudget,
    deadline,
    0,
  );
  if (roundOne.length === 0) {
    throw new NoLegalActionError(playerID, 0);
  }

  // Rounds 2..N: beam-extend the top lines with another Hard-quality search
  // of each future Bot turn. Each line keeps its first move; the beam
  // branches over the top two next moves at every round.
  let lines = roundOne.slice(0, 3).map((line) => ({
    firstMove: line.candidate.move as BotDecision['move'],
    sim: line.replySim,
    score: line.score,
  }));
  const maxDepth = 2;
  for (let depth = 2; depth <= maxDepth; depth += 1) {
    const nextLines: typeof lines = [];
    for (const line of lines) {
      if (performance.now() >= deadline || nodeBudget.used >= nodeBudget.max) {
        timedOut = true;
        break;
      }
      if (line.sim.G.result !== null) {
        nextLines.push(line);
        continue;
      }
      const nextTurnSim = createSimulation(cloneState(line.sim.G), ctxOf(line.sim));
      playOpponentsUntilBot(
        nextTurnSim,
        playerID,
        weights,
        seed,
        depth,
        memory,
        deadline,
        nodeBudget,
        0,
      );
      if (nextTurnSim.G.result !== null || nextTurnSim.currentPlayer !== playerID) {
        nextLines.push({
          ...line,
          score: evaluateLeaf(nextTurnSim.G, playerID, weights, memory),
        });
        continue;
      }
      const round = runRound(
        nextTurnSim.G,
        ctxOf(nextTurnSim),
        playerID,
        weights,
        seed,
        depth,
        memory,
        4,
        nodeBudget,
        deadline,
        0,
      );
      if (round.length === 0) {
        nextLines.push({
          ...line,
          score: evaluateLeaf(nextTurnSim.G, playerID, weights, memory),
        });
        continue;
      }
      for (const next of round.slice(0, 2)) {
        const leafSim = createSimulation(
          cloneState(next.replySim.G),
          ctxOf(next.replySim),
        );
        playOpponentsUntilBot(
          leafSim,
          playerID,
          weights,
          seed,
          depth + 10,
          memory,
          deadline,
          nodeBudget,
          0,
        );
        nextLines.push({
          firstMove: line.firstMove,
          sim: next.replySim,
          score: evaluateLeaf(leafSim.G, playerID, weights, memory),
        });
      }
      if (nextLines.length >= maxSimulations) {
        timedOut = true;
        break;
      }
    }
    if (timedOut || nextLines.length === 0) break;
    lines = nextLines
      .sort(
        (left, right) =>
          right.score - left.score ||
          JSON.stringify(left.firstMove).localeCompare(
            JSON.stringify(right.firstMove),
          ),
      )
      .slice(0, 3);
  }

  const ranked = [
    ...lines.map((line) => ({
      firstMove: line.firstMove,
      score: line.score,
    })),
    ...roundOne.slice(0, 1).map((line) => ({
      firstMove: line.candidate.move as BotDecision['move'],
      score: line.score,
    })),
  ];
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      JSON.stringify(left.firstMove).localeCompare(
        JSON.stringify(right.firstMove),
      ),
  );

  return {
    move: ranked[0].firstMove,
    modelVersion: 'ai-kernel-v0.3.0',
    policy: 'expert-v1',
    seed,
    nodesVisited: nodeBudget.used,
    elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
    timedOut,
    fallbackLevel: timedOut ? 1 : 0,
  };
};

export type { SearchBudget };
