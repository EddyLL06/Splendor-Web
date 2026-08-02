/**
 * Candidate model vs frozen baseline benchmark (DEVELOPMENT_GUIDE.md §13.4).
 * Reports 2/3/4-player win rates with Wilson 95% intervals, average ranks,
 * seat rotation bias and decision timing.
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
import { runGame, type GameOutcome } from './lib/headless.js';
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

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index] * 100) / 100;
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
  const seed = values.get('seed') ?? 'validation-v1';
  const games = Number(values.get('games') ?? '2000');
  const players = (values.get('players') ?? '2,3,4')
    .split(',')
    .map((value) => Number(value.trim()));
  const modelPath = values.get('model');
  const baseline = values.get('baseline') ?? 'uniform-random-v1';
  const rotateSeats = values.get('rotate-seats') !== 'false';
  const output = resolve(
    values.get('output') ?? `.local-data/ai-bot/runs/bench-${seed}`,
  );
  const maxActions = Number(values.get('max-actions') ?? '3000');

  if (!modelPath) throw new Error('--model is required.');
  if (players.some((count) => ![2, 3, 4].includes(count))) {
    throw new Error('--players must be 2,3 and/or 4.');
  }
  const candidateModel = parseModel(
    JSON.parse(await readFile(modelPath, 'utf8')),
  );
  const candidateWeights = {
    ...weightsFromModel(candidateModel),
  } as Record<string, number>;

  let baselineWeights: Record<string, number> | undefined;
  let baselineAgent: AgentPolicyID = 'uniform-random-v1';
  if (baseline.endsWith('.json')) {
    const baselineModel = parseModel(
      JSON.parse(await readFile(baseline, 'utf8')),
    );
    baselineWeights = {
      ...weightsFromModel(baselineModel),
    } as Record<string, number>;
    baselineAgent = 'normal-v1';
  } else if (AI_AGENTS.includes(baseline as AgentPolicyID)) {
    baselineAgent = baseline as AgentPolicyID;
  } else {
    throw new Error(`Unknown baseline "${baseline}".`);
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
  const results: GameOutcome[] = [];
  const progressEvery = Math.max(1, Math.floor(games / 10));
  for (let index = 0; index < games; index += 1) {
    const numPlayers = players[index % players.length];
    const gameIndexForCount = Math.floor(index / players.length);
    const rotate = rotateSeats ? gameIndexForCount % numPlayers : 0;
    const agentOrder = Array.from({ length: numPlayers }, (_, seat) =>
      seat === rotate ? 'normal-v1' : baselineAgent,
    ) as AgentPolicyID[];
    const weightsByAgent: Partial<
      Record<AgentPolicyID, Record<string, number>>
    > = { 'normal-v1': candidateWeights };
    if (baselineAgent === 'normal-v1' && baselineWeights) {
      weightsByAgent[baselineAgent] = baselineWeights;
    }
    results.push(
      runGame(index, numPlayers, agentOrder, `${seed}:bench`, maxActions, weightsByAgent),
    );
    if ((index + 1) % progressEvery === 0) {
      process.stdout.write(`games ${index + 1}/${games}\n`);
    }
  }
  const elapsedSec = (performance.now() - startedAt) / 1000;

  const byPlayers = Object.fromEntries(
    [2, 3, 4].map((count) => {
      const subset = results.filter((game) => game.numPlayers === count);
      const candidateSeatGames = subset.filter(
        (game) => Object.values(game.agents).includes('normal-v1'),
      );
      const wins = subset.filter((game) =>
        game.winners.some(
          (winner, _index, winners) =>
            winners.length === 1 && game.agents[winner] === 'normal-v1',
        ),
      ).length;
      const sharedWins = subset.filter(
        (game) =>
          game.winners.length > 1 &&
          game.winners.some((winner) => game.agents[winner] === 'normal-v1'),
      ).length;
      const avgRank =
        candidateSeatGames.length === 0
          ? 0
          : candidateSeatGames.reduce(
              (sum, game) =>
                sum +
                game.standings.findIndex(
                  (standing) =>
                    game.agents[standing.playerID] === 'normal-v1',
                ) +
                1,
              0,
            ) / candidateSeatGames.length;
      const stats = candidateSeatGames.reduce<{
        decisions: number;
        elapsedValuesMs: number[];
      }>(
        (acc, game) => {
          const value = game.decisionStats['normal-v1'];
          acc.decisions += value.decisions;
          acc.elapsedValuesMs.push(...value.elapsedValuesMs);
          return acc;
        },
        { decisions: 0, elapsedValuesMs: [] },
      );
      const seatWins = Object.fromEntries(
        Array.from({ length: count }, (_, seat) => {
          const seatGames = subset.filter((game) => {
            const candidateSeat = Number(
              Object.keys(game.agents).find(
                (playerID) => game.agents[playerID] === 'normal-v1',
              ),
            );
            return candidateSeat === seat;
          });
          const seatWinCount = seatGames.filter(
            (game) =>
              game.winners.length === 1 &&
              game.winners.some(
                (winner) => game.agents[winner] === 'normal-v1',
              ),
          ).length;
          return [
            String(seat),
            seatGames.length === 0
              ? null
              : { games: seatGames.length, wins: seatWinCount },
          ];
        }),
      );
      const [ciLow, ciHigh] = wilson95(wins, subset.length);
      return [
        String(count),
        {
          games: subset.length,
          candidateSeatGames: candidateSeatGames.length,
          wins,
          sharedWins,
          winRate: subset.length ? (wins / subset.length) * 100 : 0,
          ci95: [Math.round(ciLow * 1000) / 10, Math.round(ciHigh * 1000) / 10],
          avgRank: Math.round(avgRank * 100) / 100,
          seatWins,
          p50DecisionMs: percentile(stats.elapsedValuesMs, 50),
          p95DecisionMs: percentile(stats.elapsedValuesMs, 95),
          p99DecisionMs: percentile(stats.elapsedValuesMs, 99),
          decisions: stats.decisions,
        },
      ];
    }),
  );

  const illegal = results.reduce((sum, game) => sum + game.illegal, 0);
  const deadlocks = results.filter((game) => game.deadlocked).length;
  const noLegalActions = results.filter((game) => game.noLegalAction).length;
  const summaryHash = createHash('sha256')
    .update(
      JSON.stringify(
        results.map((game) => [
          game.index,
          game.numPlayers,
          game.agents,
          game.winners,
          game.illegal,
          game.deadlocked,
          game.noLegalAction,
        ]),
      ),
    )
    .digest('hex');

  const summary = {
    seed,
    games,
    players,
    candidate: candidateModel.modelVersion,
    baseline: baselineAgent === 'normal-v1' ? baseline : baselineAgent,
    rotateSeats,
    byPlayers,
    illegalActions: illegal,
    deadlocks,
    noLegalActions,
    summaryHash,
    elapsedSec: Math.round(elapsedSec * 100) / 100,
  };
  const manifest = {
    command: ['npm', 'run', 'ai:benchmark', ...argv],
    argv,
    commit,
    nodeVersion: process.version,
    platform: `${platform()} ${release()}`,
    cpu: { model: cpus()[0]?.model ?? 'unknown', logicalCores: cpus().length },
    model: modelPath,
    baseline,
    rulesFingerprint: rulesFingerprint(),
    output,
  };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(
    join(output, 'summary.md'),
    [
      `# Benchmark (${seed})`,
      '',
      `- Candidate: ${candidateModel.modelVersion} vs ${summary.baseline}`,
      `- Games: ${games} · players: ${players.join('/')} · rotate-seats: ${rotateSeats}`,
      `- Illegal: ${illegal} · deadlocks: ${deadlocks} · no-legal: ${noLegalActions}`,
      `- Hash: \`${summaryHash}\``,
      '',
      '| players | games | win% | 95% CI | shared wins | avg rank | p50 ms | p95 ms | p99 ms |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...[2, 3, 4].map((count) => {
        const value = summary.byPlayers[String(count)];
        return `| ${count} | ${value.games} | ${value.winRate.toFixed(1)}% | ${value.ci95.join('-')}% | ${value.sharedWins} | ${value.avgRank} | ${value.p50DecisionMs} | ${value.p95DecisionMs} | ${value.p99DecisionMs} |`;
      }),
      '',
    ].join('\n'),
  );
  for (const game of results) {
    if (!game.failure) continue;
    await writeFile(
      join(failuresDir, `game-${game.index}-${game.numPlayers}p.json`),
      JSON.stringify(game.failure, null, 2),
    );
  }

  process.stdout.write(
    `\nseed=${seed} candidate=${candidateModel.modelVersion} baseline=${summary.baseline} games=${games}\n` +
      `illegal=${illegal} deadlocks=${deadlocks} noLegalActions=${noLegalActions}\n` +
      `summaryHash=${summaryHash}\nelapsed=${summary.elapsedSec}s\n`,
  );
  if (illegal > 0 || noLegalActions > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
