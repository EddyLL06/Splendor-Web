/**
 * Self-play data exporter for the neural policy baseline (guide §5.2).
 * Plays seeded games with the existing search policies (teacher moves),
 * recording for every step: observation, legal actions, the chosen action
 * key and the acting player's final outcome. Training runs offline in
 * Python; this script is the only place that touches the server engine.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';

import { createInitialState } from '../../../src/shared/rules/setup.js';
import { createSeededRNG } from '../../../src/shared/ai/seeded-rng.js';
import { chooseBotMove } from '../../../src/shared/ai/policy.js';
import { enumerateLegalActions } from '../../../src/shared/ai/legal-actions.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
} from '../../../src/shared/ai/simulate.js';
import { createObservation } from '../../../src/shared/ai/observation.js';
import { createPlayerView } from '../../../src/game/playerView.js';
import { createStandings } from '../../../src/shared/rules/selectors.js';
import { parseModel, weightsFromModel } from '../../../src/shared/ai/models/schema.js';
import { NoLegalActionError } from '../../../src/shared/ai/errors.js';
import { NeuralPolicy } from '../../../src/shared/ai/neural/inference.js';
import { computeNeuralPuctDecision } from '../../../src/shared/ai/search/neural-puct.js';
import type {
  AgentPolicyID,
  BotDecision,
} from '../../../src/shared/ai/types.js';
import type {
  MainAction,
  SplendorState,
  TokenCounts,
} from '../../../src/shared/types/game.js';

type TeacherID = AgentPolicyID | 'neural-puct-v1';

const AGENT_POOL: TeacherID[] = [
  'hard-v1',
  'normal-v1',
  'expert-v1',
  'neural-puct-v1',
  'cheap-greedy-v1',
  'uniform-random-v1',
];

const parseTeachers = (value: string): TeacherID[] => {
  const teachers = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (teachers.length === 0) {
    throw new Error('--teachers must contain at least one teacher.');
  }
  for (const teacher of teachers) {
    if (!AGENT_POOL.includes(teacher as TeacherID)) {
      throw new Error(`Unknown teacher "${teacher}".`);
    }
  }
  return teachers as TeacherID[];
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
  const seed = values.get('seed') ?? 'neural-s1';
  const games = Number(values.get('games') ?? '240');
  const players = (values.get('players') ?? '2,3,4')
    .split(',')
    .map((value) => Number(value.trim()));
  const modelPath = values.get('model') ?? 'ai_bot/models/heuristic-v1.json';
  const output = resolve(
    values.get('output') ?? `.local-data/ai-bot/neural-data/${seed}`,
  );
  const maxActions = Number(values.get('max-actions') ?? '3000');
  const budgetMs = Number(values.get('budget-ms') ?? '3000');
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error('--budget-ms must be a positive number of milliseconds.');
  }
  const sims = Number(values.get('sims') ?? '96');
  if (!Number.isInteger(sims) || sims < 1) {
    throw new Error('--sims must be a positive integer.');
  }
  const determinizations = Number(values.get('determinizations') ?? '2');
  if (!Number.isInteger(determinizations) || determinizations < 1) {
    throw new Error('--determinizations must be a positive integer.');
  }
  const progressEvery = Number(values.get('progress-every') ?? '25');
  if (!Number.isInteger(progressEvery) || progressEvery < 1) {
    throw new Error('--progress-every must be a positive integer.');
  }

  const model = parseModel(
    JSON.parse(
      await readFile(modelPath, 'utf8'),
    ),
  );
  const weights = { ...weightsFromModel(model) } as Record<string, number>;
  const neuralModelPath = values.get('neural-model');
  const neural = neuralModelPath
    ? await NeuralPolicy.load(resolve(neuralModelPath))
    : undefined;
  const teachers = parseTeachers(values.get('teachers') ?? AGENT_POOL.join(','));
  if (teachers.includes('neural-puct-v1') && !neural) {
    throw new Error('--teachers includes neural-puct-v1 but --neural-model is missing.');
  }
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

  const lines: string[] = [];
  const hashes: string[] = [];
  const startedAt = performance.now();
  let positions = 0;
  let capped = 0;
  for (let gameIndex = 0; gameIndex < games; gameIndex += 1) {
    const numPlayers = players[gameIndex % players.length];
    const rng = createSeededRNG(`game:${seed}:${gameIndex}`);
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
    const agentsBySeat = Object.fromEntries(
      initialState.playerOrder.map((playerID, seat) => [
        playerID,
        teachers[(gameIndex + seat) % teachers.length],
      ]),
    ) as Record<string, TeacherID>;
    const gameLines: Array<{
      actor: string;
      entry: string;
    }> = [];
    let gameAborted = false;
    let guard = 0;
    while (sim.G.result === null && guard < maxActions) {
      guard += 1;
      const playerID = sim.currentPlayer;
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
      const legal = enumerateLegalActions(sim.G, playerID, sim.currentPlayer);
      const decisionSeed = `${seed}:${gameIndex}:${guard}`;
      let visitTarget: Record<string, number> | undefined;
      let searchValue: number | undefined;
      let decision: BotDecision;
      try {
        decision =
          agentsBySeat[playerID] === 'neural-puct-v1' && neural
            ? await computeNeuralPuctDecision({
                observation,
                ctx,
                seed: decisionSeed,
                weights,
                neural,
                budget: {
                  deadlineEpochMs: performance.now() + budgetMs,
                  simsPerDeterminization: sims,
                  determinizations,
                },
                // Bot-tree search is the current strongest teacher; the
                // alternating search still needs more value training.
                mode: 'bot-tree',
                onDebug: (rows) => {
                  visitTarget = Object.fromEntries(
                    rows.map((row) => [row.key, row.visits]),
                  );
                  searchValue = rows.reduce(
                    (best, row) => Math.max(best, row.q),
                    -1,
                  );
                },
              })
            : chooseBotMove(observation, ctx, {
                policy: agentsBySeat[playerID] as AgentPolicyID,
                seed: decisionSeed,
                weights,
              });
      } catch (caught) {
        if (caught instanceof NoLegalActionError) {
          // Known rules-layer deadlock (bank/gold empty, nothing legal).
          const pass = legal.find(
            (candidate) => candidate.actionKey === 'pass:stall-rescue',
          );
          if (!pass) {
            gameAborted = true;
            break;
          }
          decision = {
            move: pass.move,
            modelVersion: 'stall-rescue',
            policy: agentsBySeat[playerID],
            seed: decisionSeed,
            nodesVisited: 1,
            elapsedMs: 0,
            timedOut: false,
            fallbackLevel: 2,
          };
        } else {
          throw caught;
        }
      }
      const chosen = legal.find(
        (candidate) => JSON.stringify(candidate.move) === JSON.stringify(decision.move),
      );
      if (!chosen) {
        throw new Error(
          `Decision move not found in legal set (game ${gameIndex}, step ${guard}).`,
        );
      }
      gameLines.push({
        actor: playerID,
        entry: JSON.stringify({
          numPlayers,
          obs: observation,
          legal: legal.map((candidate) => ({
            key: candidate.actionKey,
            move: candidate.move,
          })),
          chosen: chosen.actionKey,
          ...(visitTarget ? { visits: visitTarget, searchValue } : {}),
        }),
      });
      const [argument] = decision.move.args;
      const result =
        decision.move.move === 'mainAction'
          ? applySimulationMainAction(sim, playerID, argument as MainAction)
          : decision.move.move === 'discardTokens'
            ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
            : applySimulationNoble(sim, playerID, argument as string);
      if (!result.ok) {
        throw new Error(
          `Agent move rejected (game ${gameIndex}, step ${guard}): ${result.errors
            .map((error) => error.code)
            .join(',')}`,
        );
      }
    }
    const standings = createStandings(sim.G);
    const winners = new Set(sim.G.result?.winners ?? []);
    if (sim.G.result === null) {
      capped += 1;
    }
    if ((gameIndex + 1) % progressEvery === 0) {
      process.stderr.write(
        `progress seed=${seed} game=${gameIndex + 1}/${games} positions=${positions} capped=${capped}\n`,
      );
    }
    if (gameAborted) continue;
    for (const line of gameLines) {
      const won = winners.has(line.actor);
      const outcome = won ? 1 : -1;
      lines.push(
        `${JSON.stringify({ gameIndex, actor: line.actor, outcome })} ${line.entry}`,
      );
    }
    positions += gameLines.length;
    hashes.push(`${gameIndex}:${sim.G.result?.winners.join(',') ?? 'none'}`);
  }

  const dataPath = join(output, 'positions.jsonl');
  await writeFile(dataPath, `${lines.join('\n')}\n`);
  const summaryHash = createHash('sha256')
    .update(hashes.join('\n'))
    .digest('hex');
  await writeFile(
    join(output, 'manifest.json'),
    JSON.stringify(
      {
        command: ['npm', 'run', 'ai:neural-export', ...argv],
        seed,
        games,
        players,
        teachers,
        budgetMs,
        sims,
        determinizations,
        capped,
        model: model.modelVersion,
        positions,
        summaryHash,
        commit,
        nodeVersion: process.version,
        platform: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model ?? 'unknown',
        elapsedMs: Math.round((performance.now() - startedAt) * 100) / 100,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    `seed=${seed} games=${games} positions=${positions} capped=${capped} hash=${summaryHash}\n`,
  );
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
