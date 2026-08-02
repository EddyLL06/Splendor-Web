import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseModel,
  weightsFromModel,
} from '../../src/shared/ai/models/schema.js';
import { buildModelDefinition } from '../../src/shared/ai/models/default.js';
import { rulesFingerprint } from '../../scripts/ai/lib/fingerprint.js';

const projectRoot = resolve(import.meta.dirname, '..', '..');

describe('model schema and default weights', () => {
  it('accepts the committed heuristic-v1 model', () => {
    const raw = JSON.parse(
      readFileSync(
        join(projectRoot, 'ai_bot/models/heuristic-v1.json'),
        'utf8',
      ),
    );
    const model = parseModel(raw);
    expect(model.modelVersion).toBe('heuristic-v1.0.0');
    expect(weightsFromModel(model).score).toBe(12);
  });

  it('rejects missing, unknown and non-finite weights', () => {
    const valid = buildModelDefinition({
      rulesFingerprint: 'a'.repeat(64),
    });
    expect(parseModel(valid)).toBeTruthy();
    const missing = structuredClone(valid);
    delete (missing.weights as Record<string, number>).score;
    expect(() => parseModel(missing)).toThrow();
    const unknown = structuredClone(valid);
    (unknown.weights as Record<string, number>).hack = 1;
    expect(() => parseModel(unknown)).toThrow();
    const nan = structuredClone(valid);
    (nan.weights as Record<string, number>).score = Number.NaN;
    expect(() => parseModel(nan)).toThrow();
  });

  it('validates the live rules fingerprint matches the committed model', () => {
    const model = parseModel(
      JSON.parse(
        readFileSync(
          join(projectRoot, 'ai_bot/models/heuristic-v1.json'),
          'utf8',
        ),
      ),
    );
    expect(model.rulesFingerprint).toBe(rulesFingerprint());
  });
});
