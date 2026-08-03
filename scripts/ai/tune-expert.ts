/**
 * Offline Expert-specific weight tuning (Rinascimento-style EF tuning).
 *
 * The Expert's leaf evaluation is the shared linear model plus a small set
 * of expert-only correction knobs (tempo cancel, affordable bonus, token
 * hoarding penalty) that are injected through reserved `__x_*` weight keys.
 * This script runs coordinate search over those knobs (plus a few base-model
 * weights) while playing the Expert against a frozen Hard baseline on
 * train-only seeds. Everything runs offline on the development machine.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';

import { FEATURE_NAMES, type FeatureVector } from '../../src/shared/ai/features.js';
import {
  parseModel,
  weightsFromModel,
} from '../../src/shared/ai/models/schema.js';
import { buildModelDefinition } from '../../src/shared/ai/models/default.js';
import { runGame } from './lib/headless.js';
import { rulesFingerprint } from './lib/fingerprint.js';
import { createSeededRNG } from '../../src/shared/ai/seeded-rng.js';

const EXPERT_KNOBS = [
  '__x_tempoCancel',
  '__x_affordableBonus',
  '__x_tokenHoardingPenalty',
  '__x_bonusCountBonus',
] as const;

const BASE_KNOBS = [
  'score',
  'tokensTotal',
  'gold',
  'affordableCount',
  'tempo',
  'bonusBalance',
  'nobleProgress',
  'opponentMaxScore',
  'purchasedCount',
  'tiebreakCards',
] as const;

type KnobName = (typeof EXPERT_KNOBS)[number] | (typeof BASE_KNOBS)[number];

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
  const seed = values.get('seed') ?? 'expert-train-v1';
  const iterations = Number(values.get('iterations') ?? '40');
  const evalGames = Number(values.get('eval-games') ?? '50');
  const base = values.get('base') ?? 'ai_bot/models/heuristic-v1.json';
  const output = resolve(
    values.get('output') ?? `.local-data/ai-bot/candidates/expert-${seed}`,
  );

  const baseModel = parseModel(
    JSON.parse(await readFile(resolve(base), 'utf8')),
  );
  const baseWeights = {
    ...weightsFromModel(baseModel),
  } as Record<string, number>;

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
    weights: Record<string, number>,
    iterationSeed: string,
  ): Promise<{ winRate: number; games: number; illegal: number }> => {
    let wins = 0;
    let draws = 0;
    let illegal = 0;
    for (let index = 0; index < evalGames; index += 1) {
      const order = index % 2 === 0
        ? (['expert-v1', 'hard-v1'] as const)
        : (['hard-v1', 'expert-v1'] as const);
      const outcome = runGame(
        index,
        2,
        [...order],
        `${iterationSeed}:tune`,
        3000,
        { 'expert-v1': weights, 'hard-v1': baseWeights },
      );
      illegal += outcome.illegal;
      if (outcome.winners.length === 1) {
        if (outcome.agents[outcome.winners[0]] === 'expert-v1') wins += 1;
      } else if (
        outcome.winners.some(
          (winner) => outcome.agents[winner] === 'expert-v1',
        )
      ) {
        draws += 1;
      }
    }
    return {
      winRate: (wins + draws * 0.5) / evalGames,
      games: evalGames,
      illegal,
    };
  };

  let bestWeights: Record<string, number> = { ...baseWeights };
  let bestResult = await evaluate(bestWeights, `${seed}:baseline`);
  if (bestResult.illegal > 0) {
    throw new Error('Baseline expert produced illegal moves during tuning.');
  }
  process.stdout.write(
    `baseline expert vs hard: ${(bestResult.winRate * 100).toFixed(1)}%\n`,
  );

  const rng = createSeededRNG(`tune-expert:${seed}`);
  const knobOrder: KnobName[] = [
    ...EXPERT_KNOBS,
    ...BASE_KNOBS,
  ];
  const stepSizes: Record<KnobName, number> = {
    __x_tempoCancel: 1.5,
    __x_affordableBonus: 2,
    __x_tokenHoardingPenalty: 0.3,
    __x_bonusCountBonus: 0.5,
    score: 2,
    tokensTotal: 0.4,
    gold: 0.6,
    affordableCount: 1,
    tempo: 1,
    bonusBalance: 1.5,
    nobleProgress: 3,
    opponentMaxScore: 1,
    purchasedCount: 0.5,
    tiebreakCards: 0.5,
  };

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const candidate: Record<string, number> = { ...bestWeights };
    const knob = knobOrder[Math.floor(rng.next() * knobOrder.length)];
    const direction = rng.next() < 0.5 ? -1 : 1;
    const step = stepSizes[knob] * direction;
    const current = candidate[knob] ?? 0;
    const next = Math.round((current + step) * 100) / 100;
    if (next < -30 || next > 60) continue;
    candidate[knob] = next;
    const result = await evaluate(candidate, `${seed}:${iteration}`);
    if (result.winRate > bestResult.winRate + 0.02) {
      bestResult = result;
      bestWeights = candidate;
      process.stdout.write(
        `iteration ${iteration + 1}/${iterations} improved ${knob}=${next} -> ${(result.winRate * 100).toFixed(1)}%\n`,
      );
    }
    if ((iteration + 1) % 10 === 0) {
      process.stdout.write(`iteration ${iteration + 1}/${iterations}\n`);
    }
  }

  const model = buildModelDefinition({
    modelVersion: `expert-heuristic-${Date.now().toString(36)}`,
    rulesFingerprint: rulesFingerprint(),
    weights: Object.fromEntries(
      FEATURE_NAMES.map((name) => [name, bestWeights[name]]),
    ) as FeatureVector,
    training: {
      algorithm: 'expert-coordinate-search-v1',
      seedSet: seed,
      games: evalGames * iterations,
    },
    validation: {
      holdoutSeedSet: 'holdout-v1',
      games: 0,
      baselineModelVersion: 'hard-v1',
    },
  });
  const modelPath = join(output, 'expert-model.json');
  await writeFile(
    modelPath,
    JSON.stringify(
      {
        ...model,
        // Reserved __x_* keys are not part of the shared feature schema;
        // the benchmark/validate CLIs merge expertExtras into the Expert's
        // weights when the candidate policy is expert-v1.
        expertExtras: Object.fromEntries(
          EXPERT_KNOBS.map((knob) => [knob, bestWeights[knob] ?? 0]),
        ),
      },
      null,
      2,
    ),
  );
  await writeFile(
    join(output, 'report.md'),
    [
      `# Expert tuning report (${seed})`,
      '',
      `- Base: ${baseModel.modelVersion}`,
      `- Baseline: hard-v1 (frozen ${baseModel.modelVersion})`,
      `- Iterations: ${iterations} · eval games/iter: ${evalGames}`,
      `- Baseline train win rate: ${(
        (await evaluate({ ...baseWeights }, `${seed}:baseline`)).winRate * 100
      ).toFixed(1)}%`,
      `- Best train win rate: ${(bestResult.winRate * 100).toFixed(1)}%`,
      `- Best extras: ${JSON.stringify(
        Object.fromEntries(
          EXPERT_KNOBS.map((knob) => [knob, bestWeights[knob] ?? 0]),
        ),
      )}`,
      `- Rules fingerprint: ${model.rulesFingerprint}`,
      '',
    ].join('\n'),
  );
  process.stdout.write(
    `\nseed=${seed} iterations=${iterations} evalGames=${evalGames}\n` +
      `bestTrainWinRate=${(bestResult.winRate * 100).toFixed(1)}%\n` +
      `candidate=${modelPath}\n`,
  );
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
