/// <reference types="node" />

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AiMetrics } from '../../src/server/ai/metrics.js';
import { shortHash } from '../../src/server/ai/sanitize.js';
import { AiWorkerPool, workerEntryFor } from '../../src/server/ai/worker-pool.js';
import { BotCoordinator } from '../../src/server/ai/bot-coordinator.js';
import { parseModel } from '../../src/shared/ai/models/schema.js';
import { rulesFingerprint } from '../../src/shared/ai/models/fingerprint.js';
import type { AppConfig } from '../../src/server/config.js';
import {
  createTestApplication,
  registerAccount,
  type RegisteredAccount,
  type TestApplication,
} from '../server-test-kit.js';

const projectRoot = resolve(import.meta.dirname, '..', '..');

describe('phase 6: bounded AI metrics', () => {
  it('aggregates decisions, percentiles and failure counters', () => {
    const metrics = new AiMetrics();
    for (let index = 0; index < 100; index += 1) {
      metrics.recordDecision(index, 'hard');
    }
    metrics.recordTimeout();
    metrics.recordFallback('search');
    metrics.recordNoLegalAction();
    metrics.recordStaleResult();
    metrics.recordQueueDepth(7);
    metrics.recordWorkerRestart();

    const snapshot = metrics.snapshot();
    expect(snapshot.decisions).toBe(100);
    expect(snapshot.decisionP50Ms).toBe(49);
    expect(snapshot.decisionP95Ms).toBe(94);
    expect(snapshot.decisionP99Ms).toBe(98);
    expect(snapshot.timeouts).toBe(1);
    expect(snapshot.fallbacks).toBe(1);
    expect(snapshot.noLegalActions).toBe(1);
    expect(snapshot.staleResults).toBe(1);
    expect(snapshot.queueDepthPeak).toBe(7);
    expect(snapshot.workerRestarts).toBe(1);
  });

  it('keeps durations bounded to the sliding window', () => {
    const metrics = new AiMetrics();
    for (let index = 0; index < 10_000; index += 1) {
      metrics.recordDecision(0, 'hard');
    }
    for (let index = 0; index < 4096; index += 1) {
      metrics.recordDecision(1000, 'hard');
    }
    const snapshot = metrics.snapshot();
    expect(snapshot.decisions).toBe(14_096);
    expect(snapshot.decisionP99Ms).toBe(1000);
  });
});

describe('phase 6: sanitized logging helpers', () => {
  it('hashes identifiers irreversibly and deterministically', () => {
    const matchID = 'match-with-sensitive-id-12345';
    const hash = shortHash(matchID);
    expect(hash).toMatch(/^[a-f0-9]{12}$/);
    expect(hash).not.toContain('match');
    expect(shortHash(matchID)).toBe(hash);
    expect(shortHash('different')).not.toBe(hash);
  });
});

describe('phase 6: model rules fingerprint', () => {
  it('matches the deployed heuristic model manifest', async () => {
    const raw = await readFile(
      resolve(projectRoot, 'ai_bot/models/heuristic-v1.json'),
      'utf8',
    );
    const model = parseModel(JSON.parse(raw));
    expect(rulesFingerprint(projectRoot)).toBe(model.rulesFingerprint);
  });
});

describe('phase 6: AI_BOT_ENABLED=false rollback', () => {
  let environment: TestApplication;
  let account: RegisteredAccount;

  beforeAll(async () => {
    environment = await createTestApplication('phase6-ai-off', {
      AI_BOT_ENABLED: 'false',
      AI_BOT_WORKERS: 'auto',
    });
    await environment.app.start();
    account = await registerAccount(environment, 'PhaseSixUser');
  });

  afterAll(async () => {
    await environment.cleanup();
  });

  it('creates no worker threads when disabled', () => {
    expect(environment.config.aiBotEnabled).toBe(false);
    expect(environment.app.aiPool.workersActive).toBe(0);
  });

  it('serves aggregate AI diagnostics only to authenticated users', async () => {
    await environment.request
      .get('/api/diagnostics/ai')
      .set('Origin', 'http://localhost:5173')
      .expect(401);
    const response = await account.agent
      .get('/api/diagnostics/ai')
      .set('Origin', 'http://localhost:5173')
      .expect(200);
    expect(response.body.enabled).toBe(false);
    expect(response.body.workerCount).toBeGreaterThanOrEqual(0);
    expect(response.body.workersActive).toBe(0);
    expect(response.body.expertEnabled).toBe(false);
    expect(response.body.model.modelVersion).toBe('heuristic-v1.0.0');
    expect(response.body.metrics).toMatchObject({
      decisions: 0,
      timeouts: 0,
      fallbacks: 0,
      noLegalActions: 0,
      staleResults: 0,
      queueDepthPeak: 0,
      workerRestarts: 0,
    });
  });

  it('does not start bot controllers when disabled', async () => {
    const tickets = {
      issueBotTicket: () => {
        throw new Error('must not issue bot tickets when AI is disabled');
      },
    };
    const coordinator = new BotCoordinator({
      db: {} as never,
      rooms: {} as never,
      tickets: tickets as never,
      config: { aiBotEnabled: false } as AppConfig,
      weights: {},
    });
    await expect(coordinator.startMatch('any-match')).resolves.toBeUndefined();
    coordinator.stopAll();
  });
});

describe('phase 6: worker pool inline mode', () => {
  it('reports zero active workers without a queue', () => {
    const pool = new AiWorkerPool({
      workerCount: 0,
      entry: workerEntryFor(),
      queueLimit: 64,
      hardMaxMs: 80,
    });
    expect(pool.workersActive).toBe(0);
    expect(pool.metrics).toMatchObject({
      queueDepth: 0,
      workerRestarts: 0,
      completedJobs: 0,
      timedOutJobs: 0,
    });
    pool.dispose();
  });
});
