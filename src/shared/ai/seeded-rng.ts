/**
 * Deterministic, seedable PRNG (mulberry32). No `Math.random()` is used
 * anywhere in the AI kernel; setup, determinization, randomized policies and
 * tie-breaks all flow through this RNG so identical seeds reproduce decisions.
 */

export interface SeededRNG {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Uniform random element. */
  choice<T>(items: readonly T[]): T;
  /** Fisher–Yates shuffle (returns a new array). */
  shuffle<T>(items: readonly T[]): T[];
}

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

export const hashSeed = (seed: string | number): number => {
  if (typeof seed === 'number') return seed >>> 0;
  let hash = FNV_OFFSET;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
};

export const createSeededRNG = (seed: string | number): SeededRNG => {
  let state = hashSeed(seed);
  if (state === 0) state = 0x9e3779b9;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    int: (maxExclusive: number): number => {
      if (!Number.isSafeInteger(maxExclusive) || maxExclusive <= 0) {
        throw new Error('int(maxExclusive) requires a positive integer.');
      }
      return Math.floor(next() * maxExclusive);
    },
    choice: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('choice() requires at least one item.');
      return items[Math.floor(next() * items.length)];
    },
    shuffle: <T>(items: readonly T[]): T[] => {
      const result = [...items];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(next() * (index + 1));
        [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
      }
      return result;
    },
  };
};

export const seededShuffle = <T>(rng: SeededRNG, items: readonly T[]): T[] =>
  rng.shuffle(items);
