import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NORMAL_COLORS } from '../src/shared/constants/colors.js';
import type {
  DevelopmentCard,
  GemCounts,
  Noble,
  Tier,
} from '../src/shared/types/game.js';

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_DIR = resolve(PROJECT_ROOT, 'card_data');
const OUTPUT_FILE = resolve(
  PROJECT_ROOT,
  'src/shared/data/generated-game-data.ts',
);

const EXPECTED_DECK_COUNTS: Record<Tier, number> = {
  1: 40,
  2: 30,
  3: 20,
};

const EXPECTED_PER_SUIT: Record<Tier, number> = {
  1: 8,
  2: 6,
  3: 4,
};

const splitRows = (input: string): string[][] =>
  input
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => line.split(',').map((value) => value.trim()));

const parseInteger = (
  raw: string | undefined,
  description: string,
): number => {
  if (raw === undefined || raw === '') {
    throw new Error(`${description} is missing.`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`${description} must be an integer; received "${raw}".`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${description} must be a non-negative safe integer; received "${raw}".`,
    );
  }
  return value;
};

const parseMetadata = (
  row: string[] | undefined,
  expectedCount: number,
  sourceName: string,
): void => {
  if (!row || row.length !== 2) {
    throw new Error(`${sourceName} must contain a two-value metadata row.`);
  }
  const declaredCount = parseInteger(row[0], `${sourceName} metadata count`);
  const suitCount = parseInteger(row[1], `${sourceName} metadata suit count`);
  if (declaredCount !== expectedCount) {
    throw new Error(
      `${sourceName} declares ${declaredCount} items; expected ${expectedCount}.`,
    );
  }
  if (suitCount !== NORMAL_COLORS.length) {
    throw new Error(
      `${sourceName} declares ${suitCount} suits; expected ${NORMAL_COLORS.length}.`,
    );
  }
};

const toGemCounts = (
  row: string[],
  startIndex: number,
  description: string,
): GemCounts => ({
  white: parseInteger(row[startIndex], `${description} white cost`),
  blue: parseInteger(row[startIndex + 1], `${description} blue cost`),
  green: parseInteger(row[startIndex + 2], `${description} green cost`),
  red: parseInteger(row[startIndex + 3], `${description} red cost`),
  black: parseInteger(row[startIndex + 4], `${description} black cost`),
});

export const parseDeckCsv = (
  input: string,
  tier: Tier,
  sourceName = `deck${tier}.csv`,
): DevelopmentCard[] => {
  const rows = splitRows(input);
  const header = rows[0]?.join(',');
  if (header !== '#suit,points,cost0,cost1,cost2,cost3,cost4') {
    throw new Error(`${sourceName} has an unexpected header.`);
  }

  const expectedCount = EXPECTED_DECK_COUNTS[tier];
  parseMetadata(rows[1], expectedCount, sourceName);
  const dataRows = rows.slice(2);
  if (dataRows.length !== expectedCount) {
    throw new Error(
      `${sourceName} contains ${dataRows.length} cards; expected ${expectedCount}.`,
    );
  }

  const cards = dataRows.map((row, index): DevelopmentCard => {
    const description = `${sourceName} row ${index + 3}`;
    if (row.length !== 7) {
      throw new Error(`${description} must contain exactly 7 values.`);
    }
    const suitIndex = parseInteger(row[0], `${description} suit`);
    if (suitIndex < 0 || suitIndex >= NORMAL_COLORS.length) {
      throw new Error(`${description} suit must be between 0 and 4.`);
    }
    return {
      id: `L${tier}-${String(index + 1).padStart(3, '0')}`,
      tier,
      bonus: NORMAL_COLORS[suitIndex],
      points: parseInteger(row[1], `${description} points`),
      cost: toGemCounts(row, 2, description),
    };
  });

  for (const color of NORMAL_COLORS) {
    const count = cards.filter((card) => card.bonus === color).length;
    if (count !== EXPECTED_PER_SUIT[tier]) {
      throw new Error(
        `${sourceName} contains ${count} ${color} cards; expected ${EXPECTED_PER_SUIT[tier]}.`,
      );
    }
  }

  return cards;
};

export const parseNoblesCsv = (
  input: string,
  sourceName = 'nobles.csv',
): Noble[] => {
  const rows = splitRows(input);
  const header = rows[0]?.join(',');
  if (header !== '#points,cost0,cost1,cost2,cost3,cost4') {
    throw new Error(`${sourceName} has an unexpected header.`);
  }

  parseMetadata(rows[1], 10, sourceName);
  const dataRows = rows.slice(2);
  if (dataRows.length !== 10) {
    throw new Error(
      `${sourceName} contains ${dataRows.length} nobles; expected 10.`,
    );
  }

  return dataRows.map((row, index): Noble => {
    const description = `${sourceName} row ${index + 3}`;
    if (row.length !== 6) {
      throw new Error(`${description} must contain exactly 6 values.`);
    }
    return {
      id: `N-${String(index + 1).padStart(3, '0')}`,
      points: parseInteger(row[0], `${description} points`),
      requirement: toGemCounts(row, 1, description),
    };
  });
};

export interface ConvertedGameData {
  cards: DevelopmentCard[];
  nobles: Noble[];
}

export const convertSourceData = (
  sourceDirectory = SOURCE_DIR,
): ConvertedGameData => {
  const cards = ([1, 2, 3] as const).flatMap((tier) =>
    parseDeckCsv(
      readFileSync(resolve(sourceDirectory, `deck${tier}.csv`), 'utf8'),
      tier,
    ),
  );
  const nobles = parseNoblesCsv(
    readFileSync(resolve(sourceDirectory, 'nobles.csv'), 'utf8'),
  );
  return { cards, nobles };
};

export const renderGeneratedModule = ({
  cards,
  nobles,
}: ConvertedGameData): string => `// Generated by scripts/convert-game-data.ts.
// Do not edit manually; card_data/*.csv are the source of truth.
import type { DevelopmentCard, Noble } from '../types/game.js';

export const DEVELOPMENT_CARDS: DevelopmentCard[] = ${JSON.stringify(cards, null, 2)};

export const NOBLES: Noble[] = ${JSON.stringify(nobles, null, 2)};
`;

export const generateGameData = (): ConvertedGameData => {
  const data = convertSourceData();
  writeFileSync(OUTPUT_FILE, renderGeneratedModule(data), 'utf8');
  return data;
};

const isDirectRun =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const data = generateGameData();
  console.log(
    `Generated ${data.cards.length} development cards and ${data.nobles.length} nobles at ${OUTPUT_FILE}.`,
  );
}
