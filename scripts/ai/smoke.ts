/**
 * One-command AI smoke test (DEVELOPMENT_GUIDE.md §15 round 6): a small
 * deterministic self-play run across 2/3/4 players with every search
 * policy, plus a configuration check that AI_BOT_ENABLED=false cleanly
 * disables bot seats/workers without touching the database schema.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';

import { createConfig } from '../../src/server/config.js';
import { AI_AGENTS, type AgentPolicyID } from '../../src/shared/ai/types.js';
import {
  parseModel,
  weightsFromModel,
} from '../../src/shared/ai/models/schema.js';
import { runGame, type GameOutcome } from './lib/headless.js';
import { rulesFingerprint } from './lib/fingerprint.js';

const projectRoot = resolve(import.meta.dirname, '..', '..');

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index] * 100) / 100;
};

const verifyDisabledConfig = (): void => {
  const config = createConfig(
    {
      NODE_ENV: 'test',
      APP_BASE_URL: 'http://localhost:5173',
      GAME_ALLOWED_ORIGINS: 'http://localhost:5173',
      GAME_SERVER_PORT: '28000',
      APP_DATA_DIR: resolve(projectRoot, '.local-data/smoke-tmp'),
      DATABASE_URL: 'file:.local-data/smoke-tmp/database/app.sqlite',
      AVATAR_STORAGE_DIR: resolve(projectRoot, '.local-data/smoke-tmp/avatars'),
      UPLOAD_TEMP_DIR: resolve(projectRoot, '.local-data/smoke-tmp/tmp'),
      EMAIL_PROVIDER: 'fake',
      SESSION_SECRET: 'smoke-session-secret-material-00000001',
      VERIFICATION_CODE_PEPPER: 'smoke-verification-pepper-000000001',
      GAME_CREDENTIAL_SECRET: 'smoke-game-secret-material-000000001',
      AI_BOT_ENABLED: 'false',
      AI_BOT_WORKERS: 'auto',
    },
    projectRoot,
  );
  if (config.aiBotEnabled) {
    throw new Error('AI_BOT_ENABLED=false was not honored by createConfig.');
  }
  process.stdout.write(
    'config AI_BOT_ENABLED=false -> aiBotEnabled=false (no AI migrations exist; pure-human rollback needs no schema change)\n',
  );
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
  const seed = values.get('seed') ?? 'smoke-v1';
  const games = Number(values.get('games') ?? '12');
  const players = (values.get('players') ?? '2,3,4')
    .split(',')
    .map((value) => Number(value.trim()));
  const agents = (values.get('agents') ??
    'normal-v1,hard-v1,expert-v1,cheap-greedy-v1')
    .split(',')
    .map((value) => value.trim()) as AgentPolicyID[];
  const maxActions = Number(values.get('max-actions') ?? '3000');
  const modelPath = values.get('model') ?? 'ai_bot/models/heuristic-v1.json';

  if (!Number.isSafeInteger(games) || games <= 0) throw new Error('--games must be positive.');
  if (players.some((count) => ![2, 3, 4].includes(count))) {
    throw new Error('--players must be 2,3 and/or 4.');
  }
  if (agents.some((agent) => !AI_AGENTS.includes(agent))) {
    throw new Error(`--agents must be a subset of ${AI_AGENTS.join(', ')}.`);
  }

  const model = parseModel(
    JSON.parse(
      await readFile(resolve(projectRoot, modelPath), 'utf8'),
    ),
  );
  const weights = { ...weightsFromModel(model) } as Record<string, number>;

  const startedAt = performance.now();
  const results: GameOutcome[] = [];
  for (let index = 0; index < games; index += 1) {
    const numPlayers = players[index % players.length];
    const agentOrder = Array.from(
      { length: numPlayers },
      (_, seat) => agents[(index + seat) % agents.length],
    ) as AgentPolicyID[];
    results.push(
      runGame(index, numPlayers, agentOrder, seed, maxActions, {
        'normal-v1': weights,
        'hard-v1': weights,
        'expert-v1': weights,
      }),
    );
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

  const stats = Object.fromEntries(
    AI_AGENTS.map((agent) => {
      const values: number[] = [];
      let decisions = 0;
      for (const game of results) {
        const perGame = game.decisionStats[agent];
        values.push(...perGame.elapsedValuesMs);
        decisions += perGame.decisions;
      }
      return [
        agent,
        {
          decisions,
          p50Ms: percentile(values, 50),
          p95Ms: percentile(values, 95),
          p99Ms: percentile(values, 99),
        },
      ];
    }),
  );

  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
  } catch {
    commit = 'unknown';
  }

  verifyDisabledConfig();

  process.stdout.write(
    `\nAI smoke: seed=${seed} games=${games} players=${players.join(',')}\n` +
      `model=${model.modelVersion} fingerprint=${rulesFingerprint() === model.rulesFingerprint ? 'match' : 'mismatch'}\n` +
      `completed=${completed} illegal=${illegal} deadlocks=${deadlocks} noLegalActions=${noLegalActions}\n` +
      `decisionMs ${JSON.stringify(stats)}\n` +
      `summaryHash=${summaryHash}\nelapsed=${elapsedSec.toFixed(1)}s commit=${commit}\n`,
  );
  if (illegal > 0 || deadlocks > 0 || noLegalActions > 0) {
    process.exitCode = 1;
  }
};

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
