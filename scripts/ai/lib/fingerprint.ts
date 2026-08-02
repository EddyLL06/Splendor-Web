import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..', '..', '..');

const RULE_FILES = [
  'src/shared/rules/engine.ts',
  'src/shared/rules/selectors.ts',
  'src/shared/rules/setup.ts',
  'src/shared/types/game.ts',
  'src/shared/data/gameData.ts',
  'src/shared/data/generated-game-data.ts',
  'src/game/SplendorGame.ts',
  'src/game/playerView.ts',
];

export const rulesFingerprint = (): string => {
  const hash = createHash('sha256');
  for (const file of RULE_FILES) {
    const content = readFileSync(join(projectRoot, file), 'utf8');
    hash.update(`${file}\n${content}\n`);
  }
  return hash.digest('hex');
};
