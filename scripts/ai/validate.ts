/**
 * Holdout model promotion check (DEVELOPMENT_GUIDE.md §13.6): candidate vs
 * frozen baseline on seeds never used for tuning. 2-player criterion for
 * Normal: point estimate >= 60% vs uniform-random and no regressions.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';

import { AI_AGENTS, type AgentPolicyID } from '../../src/shared/ai/types.js';
import {
  parseModel,
  weightsFromModel,
} from '../../src/shared/ai/models/schema.js';
import { runGame } from './lib/headless.js';
import { rulesFingerprint } from './lib/fingerprint.js';

const wilson95 = (wins: number, games: number): [number, number] => {
  if (games === 0) return [0, 0];
  const p = wins / games;
  const z = 1.96;
  const center = (p + z * z / (2 * games)) / (1 + z * z / games);
  const margin =
    (z * Math.sqrt((p * (1 - p)) / games + z * z / (4 * games * games))) /
    (1 + z * z / games);
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
};

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
  const seed = values.get('seed') ?? 'holdout-v1';
  const games = Number(values.get('games') ?? '4000');
  const candidatePath = values.get('candidate');
  const production = values.get('production') ?? 'uniform-random-v1';
  const output = resolve(
    values.get('output') ?? `.local-data/ai-bot/runs/validate-${seed}`,
  );
  const maxActions = Number(values.get('max-actions') ?? '3000');
  if (!candidatePath) throw new Error('--candidate is required.');

  const rawCandidate = JSON.parse(
    await readFile(candidatePath, 'utf8'),
  ) as { expertExtras?: Record<string, number> };
  const candidateModel = parseModel(rawCandidate);
  const candidateWeights = {
    ...weightsFromModel(candidateModel),
    ...(rawCandidate.expertExtras ?? {}),
  } as Record<string, number>;
  let productionWeights: Record<string, number> | undefined;
  let productionAgent: AgentPolicyID = 'uniform-random-v1';
  if (production.endsWith('.json')) {
    const productionModel = parseModel(
      JSON.parse(await readFile(production, 'utf8')),
    );
    productionWeights = {
      ...weightsFromModel(productionModel),
    } as Record<string, number>;
    productionAgent = 'normal-v1';
  } else if (AI_AGENTS.includes(production as AgentPolicyID)) {
    productionAgent = production as AgentPolicyID;
  } else {
    throw new Error(`Unknown production baseline "${production}".`);
  }

  const failuresDir = join(output, 'failures');
  await mkdir(failuresDir, { recursive: true });
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: resolve(import.meta.dirname, '..', '..'),
      encoding: 'utf8',
    }).trim();
  } catch {
    commit = 'unknown';
  }

  const startedAt = performance.now();
  let illegal = 0;
  let deadlocks = 0;
  let noLegalActions = 0;
  let wins = 0;
  let draws = 0;
  const hashes: string[] = [];
  for (let index = 0; index < games; index += 1) {
    const agentOrder: AgentPolicyID[] = [
      'normal-v1',
      productionAgent,
    ];
    const weightsByAgent: Partial<
      Record<AgentPolicyID, Record<string, number>>
    > = { 'normal-v1': candidateWeights };
    if (productionAgent === 'normal-v1' && productionWeights) {
      weightsByAgent[productionAgent] = productionWeights;
    }
    const outcome = runGame(
      index,
      2,
      index % 2 === 0 ? agentOrder : [agentOrder[1], agentOrder[0]],
      `${seed}:holdout`,
      maxActions,
      weightsByAgent,
    );
    illegal += outcome.illegal;
    deadlocks += outcome.deadlocked ? 1 : 0;
    noLegalActions += outcome.noLegalAction ? 1 : 0;
    if (outcome.winners.length === 1) {
      if (outcome.agents[outcome.winners[0]] === 'normal-v1') wins += 1;
    } else if (
      outcome.winners.some(
        (winner) => outcome.agents[winner] === 'normal-v1',
      )
    ) {
      draws += 1;
    }
    hashes.push(
      `${index}:${outcome.winners.join(',')}:${outcome.agents[0]}:${outcome.illegal}`,
    );
    if ((index + 1) % Math.max(1, Math.floor(games / 10)) === 0) {
      process.stdout.write(`games ${index + 1}/${games}\n`);
    }
  }
  const elapsedSec = (performance.now() - startedAt) / 1000;
  const effectiveGames = games;
  const winRate = (wins + draws * 0.5) / effectiveGames;
  const [ciLow, ciHigh] = wilson95(
    wins + draws * 0.5,
    effectiveGames,
  );
  const promoted =
    illegal === 0 &&
    noLegalActions === 0 &&
    productionAgent === 'uniform-random-v1' &&
    winRate >= 0.6;
  const summaryHash = createHash('sha256')
    .update(hashes.join('\n'))
    .digest('hex');

  const summary = {
    seed,
    games,
    candidate: candidateModel.modelVersion,
    production: productionAgent === 'normal-v1' ? production : productionAgent,
    wins,
    draws,
    winRate: Math.round(winRate * 10000) / 100,
    ci95: [Math.round(ciLow * 10000) / 100, Math.round(ciHigh * 10000) / 100],
    illegal,
    deadlocks,
    noLegalActions,
    promoted,
    summaryHash,
    elapsedSec: Math.round(elapsedSec * 100) / 100,
  };
  const manifest = {
    command: ['npm', 'run', 'ai:validate', ...argv],
    argv,
    commit,
    nodeVersion: process.version,
    platform: `${platform()} ${release()}`,
    cpu: { model: cpus()[0]?.model ?? 'unknown', logicalCores: cpus().length },
    candidate: candidatePath,
    production,
    rulesFingerprint: rulesFingerprint(),
    output,
  };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(
    join(output, 'summary.md'),
    [
      `# Holdout validation (${seed})`,
      '',
      `- Candidate: ${candidateModel.modelVersion}`,
      `- Production/baseline: ${summary.production}`,
      `- 2-player win rate: ${summary.winRate}% (95% CI ${summary.ci95.join('-')}%)`,
      `- Wins: ${wins} · shared wins (0.5 each): ${draws}`,
      `- Illegal: ${illegal} · deadlocks: ${deadlocks} · no-legal: ${noLegalActions}`,
      `- Promoted: ${promoted}`,
      `- Hash: \`${summaryHash}\``,
      '',
    ].join('\n'),
  );
  process.stdout.write(
    `\nseed=${seed} candidate=${candidateModel.modelVersion} baseline=${summary.production}\n` +
      `winRate=${summary.winRate}% ci95=${summary.ci95.join('-')}% wins=${wins} shared=${draws}\n` +
      `illegal=${illegal} deadlocks=${deadlocks} noLegalActions=${noLegalActions}\n` +
      `promoted=${promoted} summaryHash=${summaryHash} elapsed=${summary.elapsedSec}s\n`,
  );
  if (!promoted) process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
