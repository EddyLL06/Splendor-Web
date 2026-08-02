/**
 * Headless deterministic self-play runner (DEVELOPMENT_GUIDE.md §13.1).
 *
 * Runs offline only: no Koa, Socket.IO, Prisma, browser or worker threads.
 * Every game is fully seeded; the same command and seed reproduce the same
 * summary hash. Failures (illegal action, deadlock, no legal action) are
 * written as minimal repros under the output failures/ directory and make
 * the process exit non-zero.
 *
 * Usage:
 *   npm run ai:self-play -- --seed smoke-v1 --games 100 --players 2,3,4 \
 *     --agents uniform-random-v1,cheap-greedy-v1 --output .local-data/ai-bot/runs/smoke-v1
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { join, resolve } from 'node:path';

import { createPlayerView } from '../../src/game/playerView.js';
import { AI_AGENTS, type AgentPolicyID } from '../../src/shared/ai/types.js';
import type { BotDecision } from '../../src/shared/ai/types.js';
import {
  createObservation,
  type AIObservation,
} from '../../src/shared/ai/observation.js';
import {
  NoLegalActionError,
  chooseBotMove,
} from '../../src/shared/ai/policy.js';
import { createSeededRNG } from '../../src/shared/ai/seeded-rng.js';
import {
  applySimulationDiscard,
  applySimulationMainAction,
  applySimulationNoble,
  createSimulation,
  type SimulationState,
} from '../../src/shared/ai/simulate.js';
import { createStandings } from '../../src/shared/rules/selectors.js';
import { createInitialState } from '../../src/shared/rules/setup.js';
import type {
  MainAction,
  PlayerID,
  SplendorState,
  TokenCounts,
} from '../../src/shared/types/game.js';
import type { BoardContextView } from '../../src/shared/ai/types.js';

interface CliArgs {
  seed: string;
  games: number;
  players: number[];
  agents: AgentPolicyID[];
  maxActions: number;
  output: string;
  model: string | undefined;
}

const parseArgs = (argv: string[]): CliArgs => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument pair: ${key ?? '(missing)'} ${value ?? ''}`);
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
  const maxActions = Number(values.get('max-actions') ?? '500');
  const output = values.get('output') ?? `.local-data/ai-bot/runs/self-play-${seed}`;
  const model = values.get('model');

  if (!Number.isSafeInteger(games) || games <= 0) {
    throw new Error('--games must be a positive integer.');
  }
  if (players.length === 0 || players.some((count) => ![2, 3, 4].includes(count))) {
    throw new Error('--players must be a comma list of 2, 3 and/or 4.');
  }
  if (agents.length === 0 || agents.some((agent) => !AI_AGENTS.includes(agent))) {
    throw new Error(`--agents must be a subset of ${AI_AGENTS.join(', ')}.`);
  }
  if (!Number.isSafeInteger(maxActions) || maxActions <= 0) {
    throw new Error('--max-actions must be a positive integer.');
  }
  return { seed, games, players, agents, maxActions, output, model };
};

interface DecisionStats {
  decisions: number;
  totalElapsedMs: number;
  totalNodes: number;
  elapsedValuesMs: number[];
}

const createDecisionStats = (): DecisionStats => ({
  decisions: 0,
  totalElapsedMs: 0,
  totalNodes: 0,
  elapsedValuesMs: [],
});

interface GameOutcome {
  index: number;
  seed: string;
  numPlayers: number;
  agents: Record<PlayerID, AgentPolicyID>;
  winners: PlayerID[];
  standings: { playerID: string; score: number; purchasedCardCount: number }[];
  actions: number;
  completedTurns: number;
  illegal: number;
  deadlocked: boolean;
  noLegalAction: boolean;
  decisionStats: Record<AgentPolicyID, DecisionStats>;
  failure?: {
    actionIndex: number;
    error: string;
    state: SplendorState;
    observation: AIObservation;
    move?: unknown;
  };
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index] * 100) / 100;
};

const ctxOf = (sim: SimulationState): BoardContextView => ({
  currentPlayer: sim.currentPlayer,
  playOrder: sim.playOrder,
  playOrderPos: sim.playOrderPos,
});

const runGame = (
  index: number,
  numPlayers: number,
  agentOrder: AgentPolicyID[],
  seed: string,
  maxActions: number,
): GameOutcome => {
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
  const agentsBySeat = Object.fromEntries(
    initialState.playerOrder.map((playerID, seat) => [
      playerID,
      agentOrder[seat % agentOrder.length],
    ]),
  ) as Record<PlayerID, AgentPolicyID>;
  const outcome: GameOutcome = {
    index,
    seed,
    numPlayers,
    agents: agentsBySeat,
    winners: [],
    standings: [],
    actions: 0,
    completedTurns: 0,
    illegal: 0,
    deadlocked: false,
    noLegalAction: false,
    decisionStats: {
      'uniform-random-v1': createDecisionStats(),
      'cheap-greedy-v1': createDecisionStats(),
    },
  };

  while (outcome.actions < maxActions && sim.G.result === null) {
    const actionIndex = outcome.actions;
    const playerID = sim.currentPlayer;
    const agent = agentsBySeat[playerID];
    const playerView = createPlayerView(sim.G, playerID);
    const observation = createObservation(playerView, playerID, ctxOf(sim));
    const decisionSeed = `${seed}:${index}:${actionIndex}`;
    const startedAt = performance.now();
    let decision: BotDecision;
    try {
      decision = chooseBotMove(observation, ctxOf(sim), {
        policy: agent,
        seed: decisionSeed,
      });
    } catch (caught) {
      if (caught instanceof NoLegalActionError) {
        outcome.noLegalAction = true;
        outcome.failure = {
          actionIndex,
          error: 'NO_LEGAL_ACTION',
          state: sim.G,
          observation,
        };
        break;
      }
      throw caught;
    }
    const stats = outcome.decisionStats[agent];
    stats.decisions += 1;
    stats.totalElapsedMs += decision.elapsedMs;
    stats.totalNodes += decision.nodesVisited;
    stats.elapsedValuesMs.push(decision.elapsedMs);

    const [argument] = decision.move.args;
    const result =
      decision.move.move === 'mainAction'
        ? applySimulationMainAction(sim, playerID, argument as MainAction)
        : decision.move.move === 'discardTokens'
          ? applySimulationDiscard(sim, playerID, argument as TokenCounts)
          : applySimulationNoble(sim, playerID, argument as string);
    if (!result.ok) {
      outcome.illegal += 1;
      outcome.failure = {
        actionIndex,
        error: result.errors.map((error) => error.code).join(', '),
        state: sim.G,
        observation,
        move: decision.move,
      };
      break;
    }
    outcome.actions += 1;
  }

  if (sim.G.result === null && outcome.actions >= maxActions) {
    outcome.deadlocked = true;
    outcome.failure ??= {
      actionIndex: outcome.actions - 1,
      error: `DEADLOCK: no result after ${maxActions} actions`,
      state: sim.G,
      observation: createObservation(
        createPlayerView(sim.G, sim.currentPlayer),
        sim.currentPlayer,
        ctxOf(sim),
      ),
    };
  }

  outcome.completedTurns = sim.G.completedTurns;
  outcome.standings = createStandings(sim.G);
  if (sim.G.result) outcome.winners = sim.G.result.winners;
  return outcome;
};

const percent = (numerator: number, denominator: number): string =>
  denominator === 0 ? '0.0%' : `${((numerator / denominator) * 100).toFixed(1)}%`;

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const outputRoot = resolve(args.output);
  const failuresDir = join(outputRoot, 'failures');
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
  const games: GameOutcome[] = [];
  const progressEvery = Math.max(1, Math.floor(args.games / 10));
  for (let index = 0; index < args.games; index += 1) {
    const numPlayers = args.players[index % args.players.length];
    const agentOrder = Array.from(
      { length: args.agents.length },
      (_, seat) => args.agents[(index + seat) % args.agents.length],
    );
    const outcome = runGame(
      index,
      numPlayers,
      agentOrder,
      args.seed,
      args.maxActions,
    );
    games.push(outcome);
    if ((index + 1) % progressEvery === 0) {
      process.stdout.write(`games ${index + 1}/${args.games}\n`);
    }
  }
  const elapsedSec = (performance.now() - startedAt) / 1000;

  const illegal = games.reduce((sum, game) => sum + game.illegal, 0);
  const deadlocks = games.filter((game) => game.deadlocked).length;
  const noLegalActions = games.filter((game) => game.noLegalAction).length;
  const completed = games.filter((game) => game.winners.length > 0).length;

  const canonical = games.map((game) => [
    game.index,
    game.numPlayers,
    game.seed,
    game.agents,
    game.winners,
    game.illegal,
    game.deadlocked,
    game.noLegalAction,
    game.actions,
  ]);
  const summaryHash = createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex');

  const byPlayers = Object.fromEntries(
    [2, 3, 4].map((count) => {
      const subset = games.filter((game) => game.numPlayers === count);
      return [
        String(count),
        {
          games: subset.length,
          completed: subset.filter((game) => game.winners.length > 0).length,
          illegal: subset.reduce((sum, game) => sum + game.illegal, 0),
          deadlocks: subset.filter((game) => game.deadlocked).length,
          noLegalActions: subset.filter((game) => game.noLegalAction).length,
          avgActions:
            subset.length === 0
              ? 0
              : Math.round(
                  (subset.reduce((sum, game) => sum + game.actions, 0) /
                    subset.length) *
                    10,
                ) / 10,
        },
      ];
    }),
  );

  const agentResults = Object.fromEntries(
    AI_AGENTS.map((agent) => {
      const subset = games.filter((game) =>
        Object.values(game.agents).includes(agent),
      );
      const seatGames = games.filter(
        (game) =>
          Object.values(game.agents).filter((value) => value === agent).length >
          0,
      );
      const wins = games.filter((game) =>
        game.winners.some(
          (winner) => game.agents[winner] === agent,
        ),
      ).length;
      const stats = subset.reduce<DecisionStats>(
        (acc, game) => {
          const value = game.decisionStats[agent];
          acc.decisions += value.decisions;
          acc.totalElapsedMs += value.totalElapsedMs;
          acc.totalNodes += value.totalNodes;
          acc.elapsedValuesMs.push(...value.elapsedValuesMs);
          return acc;
        },
        createDecisionStats(),
      );
      return [
        agent,
        {
          gamesPlayed: seatGames.length,
          winningGames: wins,
          winRate: percent(wins, seatGames.length),
          decisions: stats.decisions,
          avgDecisionMs: stats.decisions
            ? Math.round((stats.totalElapsedMs / stats.decisions) * 100) / 100
            : 0,
          p50DecisionMs: percentile(stats.elapsedValuesMs, 50),
          p95DecisionMs: percentile(stats.elapsedValuesMs, 95),
          p99DecisionMs: percentile(stats.elapsedValuesMs, 99),
          totalNodes: stats.totalNodes,
          avgNodesPerDecision: stats.decisions
            ? Math.round(stats.totalNodes / stats.decisions)
            : 0,
          timeouts: 0,
          fallbacks: 0,
        },
      ];
    }),
  );

  const summary = {
    seed: args.seed,
    games: args.games,
    players: args.players,
    agents: args.agents,
    maxActions: args.maxActions,
    completed,
    illegalActions: illegal,
    deadlocks,
    noLegalActions,
    byPlayers,
    agentResults,
    summaryHash,
    elapsedSec: Math.round(elapsedSec * 100) / 100,
    failuresWritten: games.filter((game) => game.failure).length,
  };

  const manifest = {
    command: ['npm', 'run', 'ai:self-play', ...process.argv.slice(2)],
    argv: process.argv.slice(2),
    commit,
    nodeVersion: process.version,
    platform: `${platform()} ${release()}`,
    cpu: {
      model: cpus()[0]?.model ?? 'unknown',
      logicalCores: cpus().length,
    },
    model: args.model ?? 'none',
    seedSets: { smoke: args.seed },
    output: outputRoot,
  };

  const lines = games
    .map((game, index) => [index, game.numPlayers, game.agents, game.winners])
    .map((line) => JSON.stringify(line));
  const md = [
    `# Self-play summary (${args.seed})`,
    '',
    `- Games: ${args.games} (players: ${args.players.join('/')})`,
    `- Agents: ${args.agents.join(', ')}`,
    `- Completed: ${completed} (${percent(completed, args.games)})`,
    `- Illegal actions: ${illegal}`,
    `- Deadlocks: ${deadlocks}`,
    `- No legal action: ${noLegalActions}`,
    `- Summary hash: \`${summaryHash}\``,
    `- Elapsed: ${summary.elapsedSec}s`,
    '',
    '## Per-agent',
    '',
    '| agent | games | win rate | decisions | avg ms | p50 | p95 | p99 | nodes/decision |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...AI_AGENTS.map((agent) => {
      const value = (summary.agentResults as Record<string, Record<string, number | string>>)[agent];
      return `| ${agent} | ${value.gamesPlayed} | ${value.winRate} | ${value.decisions} | ${value.avgDecisionMs} | ${value.p50DecisionMs} | ${value.p95DecisionMs} | ${value.p99DecisionMs} | ${value.avgNodesPerDecision} |`;
    }),
    '',
    '## Per player count',
    '',
    '| players | games | completed | illegal | deadlocks | no-legal | avg actions |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...[2, 3, 4].map((count) => {
      const value = summary.byPlayers[String(count)];
      return `| ${count} | ${value.games} | ${value.completed} | ${value.illegal} | ${value.deadlocks} | ${value.noLegalActions} | ${value.avgActions} |`;
    }),
    '',
  ].join('\n');

  await writeFile(join(outputRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(join(outputRoot, 'summary.json'), JSON.stringify(summary, null, 2));
  await writeFile(join(outputRoot, 'summary.md'), md);
  await writeFile(
    join(outputRoot, 'games.jsonl'),
    lines.map((line) => line).join('\n') + '\n',
  );

  let failuresWritten = 0;
  for (const game of games) {
    if (!game.failure) continue;
    failuresWritten += 1;
    await writeFile(
      join(failuresDir, `game-${game.index}-${game.numPlayers}p.json`),
      JSON.stringify(game.failure, null, 2),
    );
  }

  process.stdout.write(
    [
      '',
      `seed=${args.seed} games=${args.games} players=${args.players.join(',')} agents=${args.agents.join(',')}`,
      `completed=${completed} illegal=${illegal} deadlocks=${deadlocks} noLegalActions=${noLegalActions}`,
      `summaryHash=${summaryHash}`,
      `elapsed=${summary.elapsedSec}s failures=${failuresWritten}`,
      '',
    ].join('\n'),
  );

  if (illegal > 0 || deadlocks > 0 || noLegalActions > 0) {
    process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
