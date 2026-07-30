import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  convertSourceData,
  parseDeckCsv,
  parseNoblesCsv,
  renderGeneratedModule,
} from '../scripts/convert-game-data.js';
import {
  DEVELOPMENT_CARDS,
  NOBLES,
} from '../src/shared/data/gameData.js';
import { NORMAL_COLORS } from '../src/shared/constants/colors.js';

describe('source data conversion', () => {
  it('skips metadata and produces the expected counts', () => {
    const converted = convertSourceData(resolve(process.cwd(), 'card_data'));
    expect(converted.cards).toHaveLength(90);
    expect(converted.nobles).toHaveLength(10);
    expect(converted.cards.filter((card) => card.tier === 1)).toHaveLength(40);
    expect(converted.cards.filter((card) => card.tier === 2)).toHaveLength(30);
    expect(converted.cards.filter((card) => card.tier === 3)).toHaveLength(20);
    expect(converted.cards.some((card) => card.points === 40)).toBe(false);
    expect(converted.nobles.some((noble) => noble.points === 10)).toBe(false);
  });

  it('creates stable IDs and matches the committed generated module', () => {
    const converted = convertSourceData(resolve(process.cwd(), 'card_data'));
    expect(converted.cards[0].id).toBe('L1-001');
    expect(converted.cards[40].id).toBe('L2-001');
    expect(converted.cards[70].id).toBe('L3-001');
    expect(converted.nobles[0].id).toBe('N-001');
    expect(converted.cards).toEqual(DEVELOPMENT_CARDS);
    expect(converted.nobles).toEqual(NOBLES);

    const generated = readFileSync(
      resolve(process.cwd(), 'src/shared/data/generated-game-data.ts'),
      'utf8',
    );
    expect(generated).toBe(renderGeneratedModule(converted));
  });

  it('validates the expected per-suit distribution and all costs', () => {
    for (const [tier, expected] of [
      [1, 8],
      [2, 6],
      [3, 4],
    ] as const) {
      const tierCards = DEVELOPMENT_CARDS.filter((card) => card.tier === tier);
      for (const color of NORMAL_COLORS) {
        expect(tierCards.filter((card) => card.bonus === color)).toHaveLength(
          expected,
        );
      }
    }
    for (const card of DEVELOPMENT_CARDS) {
      expect(Number.isInteger(card.points)).toBe(true);
      for (const value of Object.values(card.cost)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
    expect(new Set(DEVELOPMENT_CARDS.map((card) => card.id)).size).toBe(90);
    expect(new Set(NOBLES.map((noble) => noble.id)).size).toBe(10);
    for (const noble of NOBLES) {
      expect(Number.isInteger(noble.points)).toBe(true);
      for (const value of Object.values(noble.requirement)) {
        expect(Number.isInteger(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('rejects malformed, missing, negative, and non-integer card data', () => {
    const validHeader = '#suit,points,cost0,cost1,cost2,cost3,cost4\n1,5\n';
    expect(() =>
      parseDeckCsv(`${validHeader}0,0,0,0,0,-1,0`, 1, 'bad.csv'),
    ).toThrow(/40/);

    const source = readFileSync(
      resolve(process.cwd(), 'card_data/deck1.csv'),
      'utf8',
    );
    expect(() => parseDeckCsv(source.replace('0,0,1,1,1,1,0', '0,0,1,,1,1,0'), 1))
      .toThrow(/missing/);
    expect(() => parseDeckCsv(source.replace('0,0,1,1,1,1,0', '0,0,1,-1,1,1,0'), 1))
      .toThrow(/non-negative/);
    expect(() => parseDeckCsv(source.replace('0,0,1,1,1,1,0', '0,0,1,1.5,1,1,0'), 1))
      .toThrow(/integer/);
    expect(() => parseDeckCsv(source.replace('0,0,1,1,1,1,0', '5,0,1,1,1,1,0'), 1))
      .toThrow(/between 0 and 4/);
  });

  it('rejects noble rows with invalid values', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'card_data/nobles.csv'),
      'utf8',
    );
    expect(() =>
      parseNoblesCsv(source.replace('3,0,0,3,3,3', '3,0,0,nope,3,3')),
    ).toThrow(/integer/);
  });
});
