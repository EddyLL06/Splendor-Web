/**
 * ONNX policy inference (guide §9). Loads the exported policy-value model
 * once, encodes the observation + legal actions with the shared encoder and
 * returns the highest-scoring legal move. Pure policy (no search yet);
 * bounded PUCT arrives with the search-teacher round.
 */

import * as ort from 'onnxruntime-node';

import { determinize } from '../hidden-information.js';
import { enumerateLegalActions } from '../legal-actions.js';
import { NoLegalActionError } from '../errors.js';
import { createSeededRNG } from '../seeded-rng.js';
import type { AIObservation } from '../observation.js';
import { createObservation } from '../observation.js';
import { createPlayerView } from '../../../game/playerView.js';
import type { SplendorState } from '../../types/game.js';
import type {
  BoardContextView,
  BotDecision,
} from '../types.js';
import {
  ACTION_DIM,
  OBS_DIM,
  encodeAIMove,
  encodeObservation,
} from './encode.js';

export const NEURAL_MODEL_VERSION = 'neural-policy-v1.0.0';

/** Common surface shared by single and ensemble policies. */
export interface NeuralPolicyLike {
  choose(
    observation: AIObservation,
    ctx: BoardContextView,
    seed: string,
  ): Promise<BotDecision>;
  priorOver(
    actions: Array<{ move: BotDecision['move'] }>,
    observation: AIObservation,
  ): Promise<number[]>;
  value(
    state: SplendorState,
    playerID: string,
    ctx: BoardContextView,
  ): Promise<number>;
}

export class NeuralPolicy {
  private constructor(private readonly session: ort.InferenceSession) {}

  static async load(modelPath: string): Promise<NeuralPolicy> {
    const options = {
      executionMode: 'sequential',
      graphOptimizationLevel: 'all',
    } as const;
    const intraOpThreads = Number(process.env.AI_NEURAL_INTRA_OP_THREADS ?? '0');
    const sessionOptions =
      Number.isInteger(intraOpThreads) && intraOpThreads > 0
        ? { ...options, intraOpNumThreads: intraOpThreads }
        : options;
    const session = await ort.InferenceSession.create(modelPath, sessionOptions);
    return new NeuralPolicy(session);
  }

  async choose(
    observation: AIObservation,
    ctx: BoardContextView,
    seed: string,
  ): Promise<BotDecision> {
    const startedAt = performance.now();
    const rng = createSeededRNG(`neural:${seed}`);
    const fullState = determinize(observation, rng);
    const legal = enumerateLegalActions(
      fullState,
      observation.playerID,
      observation.currentPlayer,
    );
    if (legal.length === 0) {
      throw new NoLegalActionError(observation.playerID, 0);
    }
    const actionCount = legal.length;
    const obsVector = new Float32Array(OBS_DIM);
    obsVector.set(Array.from(encodeObservation(observation)));
    const actionMatrix = new Float32Array(actionCount * ACTION_DIM);
    legal.forEach((candidate, index) => {
      actionMatrix.set(
        Array.from(encodeAIMove(candidate.move, observation)),
        index * ACTION_DIM,
      );
    });
    const mask = new Float32Array(actionCount).fill(1);
    const results = await this.session.run({
      observation: new ort.Tensor('float32', obsVector, [1, OBS_DIM]),
      actions: new ort.Tensor('float32', actionMatrix, [
        1,
        actionCount,
        ACTION_DIM,
      ]),
      action_mask: new ort.Tensor('float32', mask, [1, actionCount]),
    });
    const logits = results.logits.data as Float32Array;
    let best = 0;
    for (let index = 1; index < actionCount; index += 1) {
      if (logits[index] > logits[best]) best = index;
    }
    return {
      move: legal[best].move,
      modelVersion: NEURAL_MODEL_VERSION,
      policy: 'neural-v1',
      seed,
      nodesVisited: actionCount,
      elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      timedOut: false,
      fallbackLevel: 0,
    };
  }

  /** Softmax policy priors over the supplied legal actions. */
  async priorOver(
    actions: Array<{ move: BotDecision['move'] }>,
    observation: AIObservation,
  ): Promise<number[]> {
    const actionCount = actions.length;
    const obsVector = new Float32Array(OBS_DIM);
    obsVector.set(Array.from(encodeObservation(observation)));
    const actionMatrix = new Float32Array(actionCount * ACTION_DIM);
    actions.forEach((candidate, index) => {
      actionMatrix.set(
        Array.from(encodeAIMove(candidate.move, observation)),
        index * ACTION_DIM,
      );
    });
    const mask = new Float32Array(actionCount).fill(1);
    const results = await this.session.run({
      observation: new ort.Tensor('float32', obsVector, [1, OBS_DIM]),
      actions: new ort.Tensor('float32', actionMatrix, [
        1,
        actionCount,
        ACTION_DIM,
      ]),
      action_mask: new ort.Tensor('float32', mask, [1, actionCount]),
    });
    const logits = results.logits.data as Float32Array;
    const maximum = Math.max(...Array.from(logits));
    const exp = Array.from(logits).map((value) => Math.exp(value - maximum));
    const sum = exp.reduce((total, value) => total + value, 0);
    return exp.map((value) => value / sum);
  }

  /** Value head for a (possibly simulated) state from playerID's view. */
  async value(
    state: SplendorState,
    playerID: string,
    ctx: BoardContextView,
  ): Promise<number> {
    const observation = createObservation(
      createPlayerView(state, playerID),
      playerID,
      ctx,
    );
    const obsVector = new Float32Array(OBS_DIM);
    obsVector.set(Array.from(encodeObservation(observation)));
    const dummyActions = new Float32Array(ACTION_DIM);
    const results = await this.session.run({
      observation: new ort.Tensor('float32', obsVector, [1, OBS_DIM]),
      actions: new ort.Tensor('float32', dummyActions, [1, 1, ACTION_DIM]),
      action_mask: new ort.Tensor('float32', new Float32Array([0]), [1, 1]),
    });
    return (results.value.data as Float32Array)[0] ?? 0;
  }

  dispose(): void {
    // Session is released by GC; explicit release is not exposed in node.
  }
}

/**
 * Ensemble of policy nets: priors and values are averaged across members
 * (arithmetic mean of softmax priors, mean of values). Stronger and more
 * robust than a single checkpoint at a linear inference-cost multiple.
 */
export class EnsemblePolicy {
  private constructor(private readonly members: NeuralPolicy[]) {}

  static async load(modelPaths: string[]): Promise<EnsemblePolicy> {
    const members: NeuralPolicy[] = [];
    for (const path of modelPaths) {
      members.push(await NeuralPolicy.load(path));
    }
    return new EnsemblePolicy(members);
  }

  async choose(
    observation: AIObservation,
    ctx: BoardContextView,
    seed: string,
  ): Promise<BotDecision> {
    return this.members[0].choose(observation, ctx, seed);
  }

  async priorOver(
    actions: Array<{ move: BotDecision['move'] }>,
    observation: AIObservation,
  ): Promise<number[]> {
    const priors = await Promise.all(
      this.members.map((member) => member.priorOver(actions, observation)),
    );
    return priors[0].map((_, index) =>
      priors.reduce((sum, entry) => sum + entry[index], 0) / priors.length,
    );
  }

  async value(
    state: SplendorState,
    playerID: string,
    ctx: BoardContextView,
  ): Promise<number> {
    const values = await Promise.all(
      this.members.map((member) => member.value(state, playerID, ctx)),
    );
    return values.reduce((sum, entry) => sum + entry, 0) / values.length;
  }

  dispose(): void {
    for (const member of this.members) member.dispose();
  }
}
