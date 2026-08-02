/**
 * AI load test (DEVELOPMENT_GUIDE.md §14.7): starts a real server with bot
 * matches, drives Hard decisions through the shared worker pool, and
 * measures main-thread event-loop delay plus HTTP /api/auth/me latency.
 */

import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import supertest from 'supertest';

import { createConfig } from '../../src/server/config.js';
import { FakeEmailService } from '../../src/server/email/fake.js';
import { createGemCouncilApplication } from '../../src/server/http/app.js';
import { AI_AGENTS, type AgentPolicyID } from '../../src/shared/ai/types.js';
import { rulesFingerprint } from './lib/fingerprint.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Client } = require('boardgame.io/dist/cjs/client.js') as typeof import('boardgame.io/client');
const { SocketIO } = require('boardgame.io/dist/cjs/multiplayer.js') as typeof import('boardgame.io/multiplayer');
import { SplendorGame } from '../../src/game/SplendorGame.js';
import { createObservation } from '../../src/shared/ai/observation.js';
import { chooseBotMove } from '../../src/shared/ai/policy.js';
import type { SplendorState } from '../../src/shared/types/game.js';

type GameClient = ReturnType<typeof Client<SplendorState>>;

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return Math.round(sorted[index] * 1000) / 1000;
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
  const seed = values.get('seed') ?? 'load-v1';
  const concurrency = (values.get('concurrent-games') ?? '10,25,50')
    .split(',')
    .map((value) => Number(value.trim()));
  const difficulty = values.get('difficulty') ?? 'hard';
  const durationMs = Number(values.get('duration') ?? '12000');
  const output = resolve(
    values.get('output') ?? `.local-data/ai-bot/runs/load-${seed}`,
  );
  if (concurrency.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error('--concurrent-games must be a positive integer list.');
  }
  const agent = (difficulty === 'hard' ? 'hard-v1' : difficulty) as AgentPolicyID;
  if (!AI_AGENTS.includes(agent)) {
    throw new Error('--difficulty must be an agent policy id.');
  }

  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(tmpdir(), 'gem-council-ai-load-'));
  const databasePath = join(root, 'database', 'app.sqlite');
  await mkdir(join(root, 'database'), { recursive: true });
  await writeFile(databasePath, '', { flag: 'wx', mode: 0o600 });
  const config = createConfig({
    NODE_ENV: 'test',
    APP_BASE_URL: 'http://localhost:5173',
    GAME_ALLOWED_ORIGINS: 'http://localhost:5173',
    GAME_SERVER_PORT: String(30_000 + Math.floor(Math.random() * 20_000)),
    APP_DATA_DIR: root,
    DATABASE_URL: `file:${databasePath}`,
    AVATAR_STORAGE_DIR: join(root, 'avatars'),
    UPLOAD_TEMP_DIR: join(root, 'tmp'),
    EMAIL_PROVIDER: 'fake',
    SESSION_SECRET: 'load-test-session-secret-material-00000001',
    VERIFICATION_CODE_PEPPER: 'load-test-pepper-material-000000000001',
    GAME_CREDENTIAL_SECRET: 'load-test-game-secret-material-000000000001',
    AI_BOT_WORKERS: '2',
    AI_BOT_HARD_MAX_MS: '80',
  });
  execFileSync(
    process.execPath,
    [
      resolve(import.meta.dirname, '..', '..', 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
    ],
    {
      cwd: resolve(import.meta.dirname, '..', '..'),
      env: { ...process.env, DATABASE_URL: config.databaseUrl },
      stdio: 'pipe',
    },
  );
  const app = await createGemCouncilApplication({
    config,
    email: new FakeEmailService(),
  });
  await app.start();
  try {
    const request = supertest.agent(app.app.callback());
    const username = `LoadHost_${Date.now().toString(36)}`;
    await request
      .post('/api/auth/register/request-code')
      .set('Origin', 'http://localhost:5173')
      .send({ email: `${username.toLowerCase()}@example.test`, locale: 'en' })
      .expect(200);
    const code = (app.email as FakeEmailService).latestCode(
      `${username.toLowerCase()}@example.test`,
      'registration',
    );
    if (!code) throw new Error('Fake email did not capture the registration code.');
    const registered = await request
      .post('/api/auth/register/complete')
      .set('Origin', 'http://localhost:5173')
      .send({
        email: `${username.toLowerCase()}@example.test`,
        username,
        password: 'LoadTest!123',
        code,
      })
      .expect(200);
    const headers = {
      Origin: 'http://localhost:5173',
      'X-CSRF-Token': registered.body.csrfToken as string,
    };

    const connectDriver = (
      matchID: string,
      credentials: string,
      accessTicket: string,
    ): GameClient => {
      const client = Client<SplendorState>({
        game: SplendorGame,
        matchID,
        playerID: '0',
        credentials,
        multiplayer: SocketIO({
          server: `http://127.0.0.1:${config.port}`,
          socketOpts: { auth: { accessTicket } },
        }),
      });
      let driverBusy = false;
      client.subscribe((state) => {
        if (!state?.isConnected || state.G.result !== null) return;
        if (state.ctx.currentPlayer !== '0' || driverBusy) return;
        driverBusy = true;
        setTimeout(() => {
          try {
            const current = client.getState();
            if (!current?.isConnected || current.G.result !== null) return;
            if (current.ctx.currentPlayer !== '0') return;
            const ctx = {
              currentPlayer: '0',
              playOrder: current.ctx.playOrder,
              playOrderPos: current.ctx.playOrderPos,
            };
            const observation = createObservation(
              current.G as SplendorState,
              '0',
              ctx,
            );
            const decision = chooseBotMove(observation, ctx, {
              policy: 'cheap-greedy-v1',
              seed: `load-driver:${matchID}:${current._stateID}`,
            });
            const [argument] = decision.move.args;
            if (decision.move.move === 'mainAction') {
              client.moves.mainAction(argument);
            } else if (decision.move.move === 'discardTokens') {
              client.moves.discardTokens(argument);
            } else {
              client.moves.chooseNoble(argument);
            }
          } finally {
            driverBusy = false;
          }
        }, 5);
      });
      client.start();
      return client;
    };

    const createMatches = async (count: number): Promise<string[]> => {
      const matchIDs: string[] = [];
      const drivers: GameClient[] = [];
      for (let index = 0; index < count; index += 1) {
        const created = await request
          .post('/games/gem-council/create')
          .set(headers)
          .send({ numPlayers: 2, unlisted: true })
          .expect(200);
        const matchID = created.body.matchID as string;
        const joined = await request
          .post(`/games/gem-council/${matchID}/join`)
          .set(headers)
          .send({ playerID: '0', playerName: 'ignored' })
          .expect(200);
        await request
          .post(`/api/matches/${matchID}/bots`)
          .set(headers)
          .send({ playerID: '1', difficulty: 'hard' })
          .expect(200);
        await request
          .post(`/api/matches/${matchID}/start`)
          .set(headers)
          .expect(200);
        const access = await request
          .post(`/api/matches/${matchID}/access-ticket`)
          .set(headers)
          .send({
            role: 'player',
            playerID: '0',
            credentials: joined.body.playerCredentials,
          })
          .expect(200);
        drivers.push(
          connectDriver(
            matchID,
            joined.body.playerCredentials as string,
            access.body.accessTicket as string,
          ),
        );
        matchIDs.push(matchID);
      }
      globalDrivers.push(...drivers);
      process.stdout.write(`created ${count} matches\n`);
      return matchIDs;
    };

    const samples: Array<{
      concurrent: number;
      eventLoop: number[];
      http: number[];
    }> = [];
    for (const concurrent of concurrency) {
      const matchIDs = await createMatches(concurrent);
      const eventLoop: number[] = [];
      const http: number[] = [];
      const drift = setInterval(() => {
        const before = performance.now();
        setImmediate(() => {
          eventLoop.push(performance.now() - before);
        });
      }, 10);
      const httpTimer = setInterval(async () => {
        const started = performance.now();
        try {
          await fetch(`http://127.0.0.1:${config.port}/api/auth/me`);
          http.push(performance.now() - started);
        } catch {
          http.push(Number.POSITIVE_INFINITY);
        }
      }, 100);
      await new Promise((resolvePromise) =>
        setTimeout(resolvePromise, durationMs),
      );
      clearInterval(drift);
      clearInterval(httpTimer);
      samples.push({ concurrent, eventLoop, http });
      for (const matchID of matchIDs) {
        await request
          .delete(`/api/matches/${matchID}/bots/1`)
          .set(headers)
          .catch(() => undefined);
      }
      process.stdout.write(`concurrency ${concurrent} measured\n`);
    }

    const metrics = app.aiPool.metrics;
    const summary = {
      seed,
      concurrency,
      difficulty: agent,
      durationMs,
      samples: samples.map((sample) => ({
        concurrent: sample.concurrent,
        eventLoopDelay: {
          p50: percentile(sample.eventLoop, 50),
          p95: percentile(sample.eventLoop, 95),
          p99: percentile(sample.eventLoop, 99),
          max: Math.round(Math.max(0, ...sample.eventLoop) * 1000) / 1000,
        },
        httpLatencyMs: {
          p50: percentile(sample.http, 50),
          p95: percentile(sample.http, 95),
          p99: percentile(sample.http, 99),
        },
      })),
      pool: metrics,
      rulesFingerprint: rulesFingerprint(),
    };
    await writeFile(join(output, 'summary.json'), JSON.stringify(summary, null, 2));

    const worstP99 = Math.max(
      ...summary.samples.map((sample) => sample.eventLoopDelay.p99),
    );
    process.stdout.write(
      `\nseed=${seed} concurrency=${concurrency.join(',')} difficulty=${agent}\n` +
        `eventLoop p99 max=${worstP99}ms pool=${JSON.stringify(metrics)}\n`,
    );
    if (worstP99 >= 50) process.exitCode = 1;
  } finally {
    for (const driver of globalDrivers) driver.stop();
    await app.stop();
    await rm(root, { recursive: true, force: true });
  }
  void argv;
};

const globalDrivers: GameClient[] = [];

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error: unknown) => {
    console.error('Load test failed:', error);
    process.exit(1);
  });
