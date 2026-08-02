/**
 * Offline weight tuning: random-restart coordinate search
 * (DEVELOPMENT_GUIDE.md §13.3). Evaluates candidates with a small frozen
 * benchmark on train-only seeds; never runs on the production server.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';

import { AI_AGENTS, type AgentPolicyID } from '../../src/shared/ai/types.js';
import { FEATURE_NAMES, type FeatureVector } from '../../src/shared/ai/features.js';
import {
  parseModel,
  weightsFromModel,
} from '../../src/shared/ai/models/schema.js';
import { buildModelDefinition } from '../../src/shared/ai/models/default.js';
import { runGame } from './lib/headless.js';
import { rulesFingerprint } from './lib/fingerprint.js';
import { createSeededRNG } from '../../src/shared/ai/seeded-rng.js';

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument pair: ${key ?? '(missing)'}`);
    }
    values.set(key.slice(2), value);
  }
  const seed = values.get('seed') ?? 'train-v1';
  const iterations = Number(values.get('iterations') ?? '60');
  const evalGames = Number(values.get('eval-games') ?? '100');
  const base = values.get('base') ?? 'ai_bot/models/heuristic-v1.json';
  const baseline = values.get('baseline') ?? 'uniform-random-v1';
  const output = resolve(
    values.get('output') ?? `.local-data/ai-bot/candidates/${seed}`,
  );
  if (!base.endsWith('.json')) throw new Error('--base must be a model JSON path.');
  const baseModel = parseModel(JSON.parse(await readFile(base, 'utf8')));
  const baseWeights = weightsFromModel(baseModel);
  const baselineAgent = AI_AGENTS.includes(baseline as AgentPolicyID)
    ? (baseline as AgentPolicyID)
    : 'uniform-random-v1';

  await mkdir(output, { recursive: true });
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(import.meta.dirname, '..', '..'),
      encoding: 'utf8',
    }).trim();
  } catch {
    commit = 'unknown';
  }

  const evaluate = async (
    weights: FeatureVector,
    iterationSeed: string,
  ): Promise<number> => {
    let wins = 0;
    let draws = 0;
    let illegal = 0;
    for (let index = 0; index < evalGames; index += 1) {
      const agentOrder: AgentPolicyID[] = ['normal-v1', baselineAgent];
      const outcome = runGame(
        index,
        2,
        index % 2 === 0 ? agentOrder : [agentOrder[1], agentOrder[0]],
        `${iterationSeed}:tune`,
        3000,
        { 'normal-v1': { ...weights } as Record<string, number> },
      );
      illegal += outcome.illegal;
      if (outcome.winners.length === 1) {
        if (outcome.agents[outcome.winners[0]] === 'normal-v1') wins += 1;
      } else if (
        outcome.winners.some(
          (winner) => outcome.agents[winner] === 'normal-v1',
        )
      ) {
        draws += 1;
      }
    }
    return illegal > 0 ? 0 : (wins + draws * 0.5) / evalGames;
  };

  let bestWeights: FeatureVector = { ...baseWeights };
  let bestScore = await evaluate(bestWeights, `${seed}:baseline`);
  const rng = createSeededRNG(`tune:${seed}`);
  const stepSizes = FEATURE_NAMES.map(() => 1 + rng.next() * 2);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const candidate: FeatureVector = { ...bestWeights };
    const feature = FEATURE_NAMES[Math.floor(rng.next() * FEATURE_NAMES.length)];
    const step = stepSizes[FEATURE_NAMES.indexOf(feature)] * (rng.next() < 0.5 ? -1 : 1);
    candidate[feature] = Math.round((candidate[feature] + step) * 100) / 100;
    const score = await evaluate(candidate, `${seed}:${iteration}`);
    if (score > bestScore) {
      bestScore = score;
      bestWeights = candidate;
      process.stdout.write(
        `iteration ${iteration + 1}/${iterations} improved ${feature} -> ${score.toFixed(3)}\n`,
      );
    }
    if ((iteration + 1) % 10 === 0) {
      process.stdout.write(`iteration ${iteration + 1}/${iterations}\n`);
    }
  }

  const model = buildModelDefinition({
    modelVersion: `heuristic-v1.${Date.now().toString(36)}-train`,
    rulesFingerprint: rulesFingerprint(),
    weights: bestWeights,
    training: {
      algorithm: 'random-restart-coordinate-search-v1',
      seedSet: seed,
      games: evalGames * iterations,
    },
    validation: {
      holdoutSeedSet: 'holdout-v1',
      games: 0,
      baselineModelVersion: baselineAgent,
    },
  });
  const modelPath = join(output, 'model.json');
  await writeFile(modelPath, JSON.stringify(model, null, 2));
  await writeFile(
    join(output, 'report.md'),
    [
      `# Tuning report (${seed})`,
      '',
      `- Base: ${baseModel.modelVersion}`,
      `- Baseline: ${baselineAgent}`,
      `- Iterations: ${iterations} · eval games/iter: ${evalGames}`,
      `- Best train win rate: ${(bestScore * 100).toFixed(1)}%`,
      `- Candidate: ${model.modelVersion}`,
      `- Rules fingerprint: ${model.rulesFingerprint}`,
      '',
    ].join('\n'),
  );
  process.stdout.write(
    `\nseed=${seed} iterations=${iterations} evalGames=${evalGames} baseline=${baselineAgent}\n` +
      `bestScore=${(bestScore * 100).toFixed(1)}%\ncandidate=${modelPath}\n`,
  );
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
