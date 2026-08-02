import { describe, expect, it } from 'vitest';

import { createSeededRNG, hashSeed } from '../../src/shared/ai/seeded-rng.js';

describe('seeded RNG', () => {
  it('is deterministic for the same seed', () => {
    const first = createSeededRNG('train-v1');
    const second = createSeededRNG('train-v1');
    const firstValues = Array.from({ length: 20 }, () => first.next());
    const secondValues = Array.from({ length: 20 }, () => second.next());
    expect(firstValues).toEqual(secondValues);
  });

  it('differs across seeds', () => {
    expect(createSeededRNG('a').next()).not.toBe(createSeededRNG('b').next());
  });

  it('has stable golden values', () => {
    const rng = createSeededRNG('golden');
    const first = rng.next();
    const second = rng.next();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(Math.round(first * 1e6)).toBe(594323);
    expect(Math.round(second * 1e6)).toBe(943421);
  });

  it('produces uniform ints, choices and shuffles', () => {
    const rng = createSeededRNG('mix');
    const ints = Array.from({ length: 100 }, () => rng.int(6));
    expect(ints.every((value) => value >= 0 && value < 6)).toBe(true);
    expect(new Set(ints).size).toBeGreaterThan(1);
    expect(rng.choice(['a', 'b', 'c'])).toMatch(/^[abc]$/);
    const shuffled = rng.shuffle([1, 2, 3, 4, 5]);
    expect([...shuffled].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('hashes string seeds stably', () => {
    expect(hashSeed('smoke-v1')).toBe(hashSeed('smoke-v1'));
    expect(hashSeed('smoke-v1')).not.toBe(hashSeed('smoke-v2'));
  });
});
