/**
 * Headless deterministic self-play runner (DEVELOPMENT_GUIDE.md §13.1).
 * Same command + seed ⇒ same summary hash.
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

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index] * 100) / 100;
};

const percent = (numerator: number, denominator: number): string =>
  denominator === 0 ? '0.0%' : `${((numerator / denominator) * 100).toFixed(1)}%`;

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
  const seed = values.get('seed') ?? 'smoke-v1';
  const games = Number(values.get('games') ?? '100');
  const players = (values.get('players') ?? '2,3,4')
    .split(',')
    .map((value) => Number(value.trim()));
  const agents = (values.get('agents') ?? 'uniform-random-v1,cheap-greedy-v1')
    .split(',')
    .map((value) => value.trim()) as AgentPolicyID[];
  const maxActions = Number(values.get('max-actions') ?? '3000');
  const output = resolve(
    values.get('output') ?? `.local-data/ai-bot/runs/self-play-${seed}`,
  );
  const modelPath = values.get('model');

  if (!Number.isSafeInteger(games) || games <= 0) throw new Error('--games must be positive.');
  if (players.some((count) => ![2, 3, 4].includes(count))) {
    throw new Error('--players must be 2,3 and/or 4.');
  }
  if (agents.some((agent) => !AI_AGENTS.includes(agent))) {
    throw new Error(`--agents must be a subset of ${AI_AGENTS.join(', ')}.`);
  }
  if (!Number.isSafeInteger(maxActions) || maxActions <= 0) {
    throw new Error('--max-actions must be positive.');
  }

  let weights: Record<string, number> | undefined;
  let modelVersion = 'none';
  if (modelPath) {
    const model = parseModel(JSON.parse(await readFile(modelPath, 'utf8')));
    weights = { ...weightsFromModel(model) } as Record<string, number>;
    modelVersion = model.modelVersion;
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
    const agentOrder = Array.from(
      { length: agents.length },
      (_, seat) => agents[(index + seat) % agents.length],
    );
    results.push(
      runGame(index, numPlayers, agentOrder, seed, maxActions, {
        'normal-v1': weights,
      }),
    );
    if ((index + 1) % progressEvery === 0) {
      process.stdout.write(`games ${index + 1}/${games}\n`);
    }
  }
  const elapsedSec = (performance.now() - startedAt) / 1000;

  const illegal = results.reduce((sum, game) => sum + game.illegal, 0);
  const deadlocks = results.filter((game) => game.deadlocked).length;
  const noLegalActions = results.filter((game) => game.noLegalAction).length;
  const completed = results.filter((game) => game.winners.length > 0).length;
  const summaryHash = createHash('sha256')
    .update(
      JSON.stringify(
        results.map((game) => [
          game.index,
          game.numPlayers,
          game.seed,
          game.agents,
          game.winners,
          game.illegal,
          game.deadlocked,
          game.noLegalAction,
          game.actions,
        ]),
      ),
    )
    .digest('hex');

  const agentResults = Object.fromEntries(
    AI_AGENTS.map((agent) => {
      const subset = results.filter((game) =>
        Object.values(game.agents).includes(agent),
      );
      const wins = results.filter((game) =>
        game.winners.some((winner) => game.agents[winner] === agent),
      ).length;
      const stats = subset.reduce<{
        decisions: number;
        totalElapsedMs: number;
        totalNodes: number;
        elapsedValuesMs: number[];
      }>(
        (acc, game) => {
          const value = game.decisionStats[agent];
          acc.decisions += value.decisions;
          acc.totalElapsedMs += value.totalElapsedMs;
          acc.totalNodes += value.totalNodes;
          acc.elapsedValuesMs.push(...value.elapsedValuesMs);
          return acc;
        },
        { decisions: 0, totalElapsedMs: 0, totalNodes: 0, elapsedValuesMs: [] },
      );
      return [
        agent,
        {
          gamesPlayed: subset.length,
          winningGames: wins,
          winRate: percent(wins, subset.length),
          decisions: stats.decisions,
          avgDecisionMs: stats.decisions
            ? Math.round((stats.totalElapsedMs / stats.decisions) * 100) / 100
            : 0,
          p50DecisionMs: percentile(stats.elapsedValuesMs, 50),
          p95DecisionMs: percentile(stats.elapsedValuesMs, 95),
          p99DecisionMs: percentile(stats.elapsedValuesMs, 99),
          avgNodesPerDecision: stats.decisions
            ? Math.round(stats.totalNodes / stats.decisions)
            : 0,
          timeouts: 0,
          fallbacks: 0,
        },
      ];
    }),
  );

  const byPlayers = Object.fromEntries(
    [2, 3, 4].map((count) => {
      const subset = results.filter((game) => game.numPlayers === count);
      return [
        String(count),
        {
          games: subset.length,
          completed: subset.filter((game) => game.winners.length > 0).length,
          illegal: subset.reduce((sum, game) => sum + game.illegal, 0),
          deadlocks: subset.filter((game) => game.deadlocked).length,
          noLegalActions: subset.filter((game) => game.noLegalAction).length,
        },
      ];
    }),
  );

  const summary = {
    seed,
    games,
    players,
    agents,
    maxActions,
    modelVersion,
    completed,
    illegalActions: illegal,
    deadlocks,
    noLegalActions,
    byPlayers,
    agentResults,
    summaryHash,
    elapsedSec: Math.round(elapsedSec * 100) / 100,
    failuresWritten: results.filter((game) => game.failure).length,
  };
  const manifest = {
    command: ['npm', 'run', 'ai:self-play', ...argv],
    argv,
    commit,
    nodeVersion: process.version,
    platform: `${platform()} ${release()}`,
    cpu: { model: cpus()[0]?.model ?? 'unknown', logicalCores: cpus().length },
    model: modelPath ?? 'none',
    rulesFingerprint: rulesFingerprint(),
    seedSets: { smoke: seed },
    output,
  };

  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(
    join(output, 'summary.md'),
    [
      `# Self-play summary (${seed})`,
      '',
      `- Games: ${games} (players: ${players.join('/')})`,
      `- Agents: ${agents.join(', ')} · model: ${modelVersion}`,
      `- Completed: ${completed} (${percent(completed, games)})`,
      `- Illegal actions: ${illegal} · deadlocks: ${deadlocks} · no-legal: ${noLegalActions}`,
      `- Summary hash: \`${summaryHash}\``,
      `- Elapsed: ${summary.elapsedSec}s`,
      '',
    ].join('\n'),
  );
  let failuresWritten = 0;
  for (const game of results) {
    if (!game.failure) continue;
    failuresWritten += 1;
    await writeFile(
      join(failuresDir, `game-${game.index}-${game.numPlayers}p.json`),
      JSON.stringify(game.failure, null, 2),
    );
  }

  process.stdout.write(
    `\nseed=${seed} games=${games} players=${players.join(',')} agents=${agents.join(',')}\n` +
      `completed=${completed} illegal=${illegal} deadlocks=${deadlocks} noLegalActions=${noLegalActions}\n` +
      `summaryHash=${summaryHash}\nelapsed=${summary.elapsedSec}s failures=${failuresWritten}\n`,
  );
  if (illegal > 0 || deadlocks > 0 || noLegalActions > 0) process.exitCode = 1;
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
