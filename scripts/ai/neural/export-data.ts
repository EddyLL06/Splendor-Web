/**
 * Exports the authoritative card/noble dataset to JSON for the Python
 * training environment (guide §2.1: single source of truth).
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { DEVELOPMENT_CARDS, NOBLES } from '../../../src/shared/data/gameData.js';

const main = async (): Promise<void> => {
  const output = resolve(
    import.meta.dirname,
    '../../../ai_bot/neural/data/game-data.json',
  );
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        cards: DEVELOPMENT_CARDS,
        nobles: NOBLES,
        schemaVersion: 1,
      },
      null,
      2,
    ),
  );
  process.stdout.write(`exported ${DEVELOPMENT_CARDS.length} cards, ${NOBLES.length} nobles -> ${output}\n`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
