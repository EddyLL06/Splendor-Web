/**
 * Build-time rules fingerprint export (round 14): computes the fingerprint
 * from the source tree and writes it into the compiled server output so
 * production containers can verify the model manifest without shipping
 * `src/`. Runs at the end of `npm run build`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { rulesFingerprint } from '../../src/shared/ai/models/fingerprint.js';

const main = async (): Promise<void> => {
  const projectRoot = resolve(import.meta.dirname, '..', '..');
  const output = join(projectRoot, 'dist-server', 'ai-rules-fingerprint.txt');
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, rulesFingerprint(projectRoot), 'utf8');
  process.stdout.write(`wrote rules fingerprint to ${output}\n`);
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
