import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FEATURE_NAMES,
  extractFeatures,
} from '../../src/shared/ai/features.js';
import { createTestState, grantBonuses } from '../helpers.js';

const projectRoot = resolve(import.meta.dirname, '..', '..');

describe('feature extraction', () => {
  it('covers every feature with bounded, finite values', () => {
    const state = createTestState();
    const features = extractFeatures(state, '0');
    for (const name of FEATURE_NAMES) {
      expect(Number.isFinite(features[name]), name).toBe(true);
      expect(features[name], name).toBeGreaterThanOrEqual(-1);
      expect(features[name], name).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic and monotonic in score/bonuses', () => {
    const state = createTestState();
    const before = extractFeatures(state, '0');
    expect(extractFeatures(state, '0')).toEqual(before);
    grantBonuses(state, '0', { white: 1, blue: 0, green: 0, red: 0, black: 0 });
    const after = extractFeatures(state, '0');
    expect(after.bonusWhite).toBeGreaterThan(before.bonusWhite);
    expect(after.purchasedCount).toBeGreaterThan(before.purchasedCount);
  });

  it('matches the committed model weights exactly', () => {
    const model = JSON.parse(
      readFileSync(
        join(projectRoot, 'ai_bot/models/heuristic-v1.json'),
        'utf8',
      ),
    ) as { weights: Record<string, number> };
    expect(Object.keys(model.weights).sort()).toEqual(
      [...FEATURE_NAMES].sort(),
    );
  });
});
