/**
 * Neural policy vs Hard benchmark (guide §8). Async headless games because
 * ONNX inference is asynchronous; identical seed/rotation scheme to
 * scripts/ai/benchmark.ts.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';

import { NeuralPolicy } from '../../../src/shared/ai/neural/inference.js';
import { computeNeuralPuctDecision } from '../../../src/shared/ai/search/neural-puct.js';
import { createObservation } from '../../../src/shared/ai/observation.js';
import { chooseBotMove } from '../../../src/shared/ai/policy.js';
import { createSeededRNG } from '../../../src/shared/ai/seeded-rng.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from '../../../src/shared/ai/simulate.js';
import { createInitialState } from '../../../src/shared/rules/setup.js';
import { createStandings } from '../../../src/shared/rules/selectors.js';
import { createPlayerView } from '../../../src/game/playerView.js';
import { parseModel, weightsFromModel } from '../../../src/shared/ai/models/schema.js';
import type { BotDecision } from '../../../src/shared/ai/types.js';
import type {
  MainAction,
  TokenCounts,
} from '../../../src/shared/types/game.js';

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

interface GameResult {
  index: number;
  numPlayers: number;
  neuralWon: boolean;
  neuralSeat: number;
  illegal: number;
  deadlocked: boolean;
  neuralDecisionMs: number[];
  actions: number;
}

const playGame = async (
  index: number,
  numPlayers: number,
  neuralSeat: number,
  seed: string,
  neural: NeuralPolicy,
  weights: Record<string, number>,
  maxActions: number,
  search: boolean,
  sims: number,
  determinizations: number,
  mode: 'auto' | 'alternating' | 'bot-tree',
): Promise<GameResult> => {
  const rng = createSeededRNG(`game:${seed}:${index}`);
  const initialState = createInitialState(numPlayers, {
    Shuffle: (items) => rng.shuffle(items),
    Die: (sides) => rng.int(sides) + 1,
  });
  const sim = createSimulation(
    initialState,
    {
      currentPlayer: initialState.initialFirstPlayer,
      playOrder: initialState.playerOrder,
      playOrderPos: initialState.playerOrder.indexOf(
        initialState.initialFirstPlayer,
      ),
    },
    0,
  );
  const result: GameResult = {
    index,
    numPlayers,
    neuralWon: false,
    neuralSeat,
    illegal: 0,
    deadlocked: false,
    neuralDecisionMs: [],
    actions: 0,
  };
  let guard = 0;
  while (sim.G.result === null && guard < maxActions) {
    guard += 1;
    const playerID = sim.currentPlayer;
    const seat = sim.playOrder.indexOf(playerID);
    const ctx = {
      currentPlayer: sim.currentPlayer,
      playOrder: sim.playOrder,
      playOrderPos: sim.playOrderPos,
    };
    const observation = createObservation(
      createPlayerView(sim.G, playerID),
      playerID,
      ctx,
    );
    const decisionSeed = `${seed}:${index}:${guard}`;
    const decision: BotDecision = seat === neuralSeat
      ? search
        ? await computeNeuralPuctDecision({
            observation,
            ctx,
            seed: decisionSeed,
            weights,
            neural,
            mode,
            budget: {
              deadlineEpochMs: performance.now() + 300,
              simsPerDeterminization: sims,
              determinizations,
            },
          })
        : await neural.choose(observation, ctx, decisionSeed)
      : chooseBotMove(observation, ctx, {
          policy: 'hard-v1',
          seed: decisionSeed,
          weights,
        });
    if (seat === neuralSeat) result.neuralDecisionMs.push(decision.elapsedMs);
    const [argument] = decision.move.args;
    const applied =
      decision.move.move === 'mainAction'
        ? applySimulationMainAction(sim, playerID, argument as MainAction)
        : decision.move.move === 'discardTokens'
          ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
          : applySimulationNoble(sim, playerID, argument as string);
    if (!applied.ok) {
      result.illegal += 1;
      break;
    }
  }
  result.actions = guard;
  result.deadlocked = sim.G.result === null;
  if (sim.G.result) {
    result.neuralWon = sim.G.result.winners.includes(
      sim.playOrder[neuralSeat],
    );
  }
  return result;
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
  const seed = values.get('seed') ?? 'neural-v1';
  const games = Number(values.get('games') ?? '100');
  const players = (values.get('players') ?? '2')
    .split(',')
    .map((value) => Number(value.trim()));
  const modelPath = values.get('model') ?? '.local-data/ai-bot/neural-checkpoints/policy-s1/policy.onnx';
  const weightsPath = values.get('weights') ?? 'ai_bot/models/heuristic-v1.json';
  const output = resolve(
    values.get('output') ?? `.local-data/ai-bot/runs/neural-${seed}`,
  );
  const maxActions = Number(values.get('max-actions') ?? '3000');
  const search = values.get('search') === 'true';
  const sims = Number(values.get('sims') ?? '96');
  const determinizations = Number(values.get('determinizations') ?? '2');
  const mode = (values.get('mode') ?? 'auto') as
    | 'auto'
    | 'alternating'
    | 'bot-tree';

  const weightsModel = parseModel(
    JSON.parse(await readFile(weightsPath, 'utf8')),
  );
  const weights = { ...weightsFromModel(weightsModel) } as Record<string, number>;
  const neural = await NeuralPolicy.load(resolve(modelPath));
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

  const startedAt = performance.now();
  const results: GameResult[] = [];
  for (let index = 0; index < games; index += 1) {
    const numPlayers = players[index % players.length];
    const neuralSeat = Math.floor(index / players.length) % numPlayers;
    results.push(
      await playGame(
        index,
        numPlayers,
        neuralSeat,
        seed,
        neural,
        weights,
        maxActions,
        search,
        sims,
        determinizations,
        mode,
      ),
    );
  }
  const elapsedSec = (performance.now() - startedAt) / 1000;

  const byPlayers = Object.fromEntries(
    [2, 3, 4].map((count) => {
      const subset = results.filter((game) => game.numPlayers === count);
      const wins = subset.filter((game) => game.neuralWon).length;
      const [ciLow, ciHigh] = wilson95(wins, subset.length);
      const timings = subset.flatMap((game) => game.neuralDecisionMs);
      const percentile = (p: number): number => {
        if (timings.length === 0) return 0;
        const sorted = [...timings].sort((a, b) => a - b);
        return Math.round(
          sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] *
            100,
        ) / 100;
      };
      return [
        String(count),
        {
          games: subset.length,
          wins,
          winRate: subset.length ? (wins / subset.length) * 100 : 0,
          ci95: [Math.round(ciLow * 1000) / 10, Math.round(ciHigh * 1000) / 10],
          p50DecisionMs: percentile(50),
          p95DecisionMs: percentile(95),
          p99DecisionMs: percentile(99),
          illegal: subset.reduce((sum, game) => sum + game.illegal, 0),
          deadlocks: subset.filter((game) => game.deadlocked).length,
        },
      ];
    }),
  );
  const summary = {
    seed,
    games,
    players,
    model: modelPath,
    byPlayers,
    elapsedSec: Math.round(elapsedSec * 100) / 100,
    commit,
    summaryHash: createHash('sha256')
      .update(
        JSON.stringify(
          results.map((game) => [
            game.index,
            game.numPlayers,
            game.neuralWon,
            game.illegal,
            game.deadlocked,
          ]),
        ),
      )
      .digest('hex'),
  };
  await writeFile(
    join(output, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  await writeFile(
    join(output, 'summary.md'),
    [
      `# Neural vs Hard benchmark (${seed})`,
      '',
      `- Games: ${games} (${players.join('/')} players)`,
      `- Model: ${modelPath}`,
      `- By players: ${JSON.stringify(byPlayers)}`,
      `- Elapsed: ${summary.elapsedSec}s · hash: ${summary.summaryHash}`,
      '',
    ].join('\n'),
  );
  process.stdout.write(
    `seed=${seed} games=${games} elapsed=${summary.elapsedSec}s\n${JSON.stringify(
      byPlayers,
      null,
      1,
    )}\n`,
  );
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
