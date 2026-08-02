import type { FeatureName, FeatureVector } from '../features.js';
import {
  FEATURE_VERSION,
  MODEL_SCHEMA_VERSION,
  type ModelDefinition,
} from './schema.js';

/**
 * Hand-tuned baseline weights (features-v1). Trained candidates replace
 * these through the tune/validate pipeline; this fallback must always load.
 */
export const HAND_TUNED_WEIGHTS: FeatureVector = {
  score: 12,
  leaderGap: 6,
  distanceTo15: -3,
  bonusWhite: 2.2,
  bonusBlue: 2.2,
  bonusGreen: 2.2,
  bonusRed: 2.2,
  bonusBlack: 2.2,
  bonusBalance: 6,
  purchasedCount: 1,
  nobleProgress: 14,
  nobleCount: 20,
  tokensTotal: 1.6,
  gold: 2.5,
  affordableCount: 4,
  waste: -10,
  reservedSlots: -2,
  opponentMaxScore: -4,
  opponentNobleThreat: -5,
  blockingValue: 3,
  tempo: 3,
  tiebreakCards: -1.5,
  marketValue1: 1.2,
  marketValue2: 1.6,
  marketValue3: 2.2,
};

export const DEFAULT_MODEL_VERSION = 'heuristic-v1.0.0';

export const buildModelDefinition = (input: {
  modelVersion?: string;
  createdAt?: string;
  rulesFingerprint: string;
  weights?: Partial<Record<FeatureName, number>>;
  training?: ModelDefinition['training'];
  validation?: ModelDefinition['validation'];
}): ModelDefinition => ({
  schemaVersion: MODEL_SCHEMA_VERSION,
  modelVersion: input.modelVersion ?? DEFAULT_MODEL_VERSION,
  createdAt: input.createdAt ?? '2026-08-03T00:00:00.000Z',
  rulesFingerprint: input.rulesFingerprint,
  featureVersion: FEATURE_VERSION,
  weights: {
    ...HAND_TUNED_WEIGHTS,
    ...(input.weights ?? {}),
  } as Record<string, number>,
  training: input.training ?? {
    algorithm: 'hand-tuned-v1',
    seedSet: 'none',
    games: 0,
  },
  validation: input.validation ?? {
    holdoutSeedSet: 'holdout-v1',
    games: 0,
    baselineModelVersion: 'uniform-random-v1',
  },
});
