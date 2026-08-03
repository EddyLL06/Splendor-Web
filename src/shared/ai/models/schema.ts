import { z } from 'zod';

import { FEATURE_NAMES, type FeatureName } from '../features.js';

export const MODEL_SCHEMA_VERSION = 1;
export const FEATURE_VERSION = 'features-v1';

export const modelSchema = z
  .object({
    schemaVersion: z.literal(MODEL_SCHEMA_VERSION),
    modelVersion: z.string().min(1),
    createdAt: z.string().datetime(),
    rulesFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    featureVersion: z.literal(FEATURE_VERSION),
    weights: z.record(z.string(), z.number().finite()),
    training: z.object({
      algorithm: z.string().min(1),
      seedSet: z.string().min(1),
      games: z.number().int().nonnegative(),
    }),
    validation: z.object({
      holdoutSeedSet: z.string().min(1),
      games: z.number().int().nonnegative(),
      baselineModelVersion: z.string().min(1),
    }),
  })
  .superRefine((model, ctx) => {
    for (const name of FEATURE_NAMES) {
      if (!(name in model.weights)) {
        ctx.addIssue({
          code: 'custom',
          path: ['weights', name],
          message: `Missing weight for feature "${name}".`,
        });
      }
    }
    for (const key of Object.keys(model.weights)) {
      if (!(FEATURE_NAMES as readonly string[]).includes(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['weights', key],
          message: `Unknown feature "${key}" is not allowed.`,
        });
      }
    }
  });

export type ModelDefinition = z.infer<typeof modelSchema>;

export const parseModel = (value: unknown): ModelDefinition =>
  modelSchema.parse(value);

export const weightsFromModel = (
  model: ModelDefinition,
): Record<FeatureName, number> =>
  Object.fromEntries(
    FEATURE_NAMES.map((name) => [name, model.weights[name]]),
  ) as Record<FeatureName, number>;
