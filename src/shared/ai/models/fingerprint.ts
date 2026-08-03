import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

export const rulesFingerprint = (
  projectRoot = resolve(import.meta.dirname, '..', '..', '..', '..'),
): string => {
  const hash = createHash('sha256');
  for (const file of RULE_FILES) {
    const content = readFileSync(join(projectRoot, file), 'utf8');
    hash.update(`${file}\n${content}\n`);
  }
  return hash.digest('hex');
};

/**
 * Same fingerprint, but returns null when it cannot be computed instead of
 * throwing. Priority:
 * 1. build-time export `dist-server/ai-rules-fingerprint.txt` (production
 *    containers ship this without `src/`);
 * 2. the source tree (dev/test);
 * 3. null ("cannot verify"). Callers must never treat null as a match.
 */
export const rulesFingerprintOrNull = (
  projectRoot = resolve(import.meta.dirname, '..', '..', '..', '..'),
): string | null => {
  try {
    const built = readFileSync(
      join(projectRoot, 'dist-server', 'ai-rules-fingerprint.txt'),
      'utf8',
    ).trim();
    if (/^[a-f0-9]{64}$/.test(built)) return built;
  } catch {
    // No build-time export; fall through to the source tree.
  }
  try {
    return rulesFingerprint(projectRoot);
  } catch {
    return null;
  }
};
