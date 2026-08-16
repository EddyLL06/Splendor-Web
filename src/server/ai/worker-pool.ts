/**
 * Server-wide shared Worker Thread pool for Hard decisions
 * (DEVELOPMENT_GUIDE.md §10). Bounded queue, watchdog timeout, worker crash
 * rebuild, structured-clone messages. `workers: 0` runs inline (tests/CI);
 * production defaults to 1-2 threads, hard-capped at 4.
 */

import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { HardDecisionInput } from '../../shared/ai/search/beam.js';
import { computeHardDecision } from '../../shared/ai/search/beam.js';
import {
  computeDsSearchDecision,
  type DsSearchResult,
} from '../../shared/ai/search/ds-search.js';
import type { BotDecision } from '../../shared/ai/types.js';
import type { ExpertMemorySnapshot } from '../../shared/ai/memory.js';
import type { AiMetrics } from './metrics.js';

interface QueuedJob {
  id: number;
  input: HardDecisionInput | ExpertPoolInput;
  mode: 'hard' | 'expert';
  priority: 'live' | 'background';
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  worker?: Worker;
}

/** Expert search input accepted by the pool (budget fields optional). */
export interface ExpertPoolInput {
  observation: HardDecisionInput['observation'];
  ctx: HardDecisionInput['ctx'];
  seed: string;
  weights: Record<string, number>;
  memory?: ExpertMemorySnapshot;
  budget?: {
    deadlineEpochMs: number;
    maxSimulations?: number;
    maxDeterminizations?: number;
    determinizations?: number;
    detIndex?: number;
    detCount?: number;
  };
}

export interface WorkerPoolMetrics {
  queueDepth: number;
  workerRestarts: number;
  completedJobs: number;
  timedOutJobs: number;
}

export class AiWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly pending = new Map<number, QueuedJob>();
  private readonly queue: QueuedJob[] = [];
  private nextID = 1;
  private restarts = 0;
  private completedJobs = 0;
  private timedOutJobs = 0;
  private disposed = false;

  constructor(
    private readonly options: {
      workerCount: number;
      entry: string;
      queueLimit: number;
      hardMaxMs: number;
      expertMaxMs?: number;
      metrics?: AiMetrics;
      workerData?: Record<string, unknown>;
    },
  ) {}

  get metrics(): WorkerPoolMetrics {
    return {
      queueDepth: this.queue.length + this.pending.size,
      workerRestarts: this.restarts,
      completedJobs: this.completedJobs,
      timedOutJobs: this.timedOutJobs,
    };
  }

  get workersActive(): number {
    return this.workers.length;
  }

  async requestHardDecision(
    input: HardDecisionInput,
    priority: 'live' | 'background' = 'live',
  ): Promise<BotDecision> {
    return (await this.request(input, 'hard', priority)) as BotDecision;
  }

  /**
   * Expert decision via the ds-search engine. The determinizations are split
   * across idle workers (one slice per worker, up to the worker cap) and the
   * per-action root statistics are merged, so a 3-vCPU deployment uses all
   * cores for a single 2-player bot decision.
   */
  async requestExpertDecision(
    input: ExpertPoolInput,
    priority: 'live' | 'background' = 'live',
  ): Promise<BotDecision> {
    if (this.disposed) throw new Error('AiWorkerPool is disposed.');
    const budget = input.budget;
    const detTotal = Math.max(
      1,
      budget?.determinizations ?? budget?.maxDeterminizations ?? 9,
    );
    const simCap = Math.max(1, budget?.maxSimulations ?? 200_000);
    const deadline =
      budget?.deadlineEpochMs ??
      performance.now() + (this.options.expertMaxMs ?? 5000);

    if (this.options.workerCount === 0) {
      const result = computeDsSearchDecision({
        observation: input.observation,
        ctx: input.ctx,
        seed: input.seed,
        weights: input.weights,
        budget: {
          deadlineEpochMs: deadline,
          maxSimulations: simCap,
          determinizations: detTotal,
          detIndex: 0,
          detCount: detTotal,
        },
        memory: input.memory,
      });
      return result.decision;
    }

    const sliceCount = Math.min(this.options.workerCount, detTotal);
    const perSliceSims = Math.ceil(simCap / sliceCount);
    const tasks: Promise<DsSearchResult>[] = [];
    let assigned = 0;
    for (let index = 0; index < sliceCount; index += 1) {
      const detCount =
        Math.floor(detTotal / sliceCount) +
        (index < detTotal % sliceCount ? 1 : 0);
      if (detCount <= 0) continue;
      const detIndex = assigned;
      assigned += detCount;
      const sliceInput: ExpertPoolInput = {
        observation: input.observation,
        ctx: input.ctx,
        seed: input.seed,
        weights: input.weights,
        memory: input.memory,
        budget: {
          deadlineEpochMs: deadline,
          maxSimulations: perSliceSims,
          determinizations: detTotal,
          detIndex,
          detCount,
        },
      };
      tasks.push(
        this.request(sliceInput, 'expert', priority) as Promise<DsSearchResult>,
      );
    }

    const settled = await Promise.allSettled(tasks);
    const results = settled
      .filter(
        (entry): entry is PromiseFulfilledResult<DsSearchResult> =>
          entry.status === 'fulfilled',
      )
      .map((entry) => entry.value);
    if (results.length === 0) {
      const firstRejection = settled.find(
        (entry): entry is PromiseRejectedResult =>
          entry.status === 'rejected',
      );
      throw (firstRejection?.reason as Error) ??
        new Error('AI_BOT_WORKER_EMPTY_RESPONSE');
    }
    return mergeDsSearchResults(results, input.seed, detTotal);
  }

  /**
   * The search budget only bounds compute inside the worker; worker-thread
   * startup (module/tsx loading), queue wait and IPC round-trips add time
   * on top, especially on cold containers. The worker re-bases its deadline
   * to a fresh full window when it starts, so the watchdog must cover
   * queue wait + full search + overshoot.
   */
  private watchdogMs(): number {
    return Math.max(
      this.options.hardMaxMs + 50,
      (this.options.expertMaxMs ?? 5_000) + 2_500,
      2_000,
    );
  }

  private async request(
    input: HardDecisionInput | ExpertPoolInput,
    mode: 'hard' | 'expert',
    priority: 'live' | 'background',
  ): Promise<unknown> {
    if (this.disposed) throw new Error('AiWorkerPool is disposed.');
    if (this.options.workerCount === 0) {
      // Expert mode with 0 workers is handled in requestExpertDecision
      // (inline ds-search); this path only serves hard requests in tests.
      return computeHardDecision(input as HardDecisionInput);
    }
    if (this.queue.length + this.pending.size >= this.options.queueLimit) {
      throw new Error('AI_BOT_QUEUE_FULL');
    }
    const id = this.nextID++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.timedOutJobs += 1;
        this.options.metrics?.recordTimeout();
        reject(new Error('AI_BOT_WATCHDOG_TIMEOUT'));
      }, this.watchdogMs());
      timer.unref?.();
      const job: QueuedJob = {
        id,
        input,
        mode,
        priority,
        resolve,
        reject,
        timer,
      };
      const firstBackground = this.queue.findIndex(
        (queued) => queued.priority === 'background',
      );
      if (priority === 'live' && firstBackground >= 0) {
        this.queue.splice(firstBackground, 0, job);
      } else {
        this.queue.push(job);
      }
      this.options.metrics?.recordQueueDepth(
        this.queue.length + this.pending.size,
      );
      this.drain();
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(new Error('AiWorkerPool disposed.'));
    }
    this.pending.clear();
    for (const worker of this.workers) {
      void worker.terminate();
    }
    this.workers.length = 0;
    this.idle.length = 0;
  }

  private drain(): void {
    while (this.queue.length > 0 && this.idle.length > 0) {
      const job = this.queue.shift()!;
      const worker = this.idle.pop()!;
      this.runOnWorker(worker, job);
    }
    if (this.queue.length > 0 && this.workers.length < this.options.workerCount) {
      const worker = this.spawnWorker();
      this.workers.push(worker);
      const job = this.queue.shift()!;
      this.runOnWorker(worker, job);
      this.drain();
    }
  }

  private spawnWorker(): Worker {
    const worker = new Worker(this.options.entry, {
      execArgv: this.options.entry.endsWith('.ts')
        ? ['--import', 'tsx']
        : undefined,
      workerData: this.options.workerData,
    });
    worker.on('message', (message: { id?: number; result?: BotDecision; error?: string }) => {
      if (message?.id === undefined) return;
      const job = this.pending.get(message.id);
      if (!job) return;
      this.pending.delete(message.id);
      clearTimeout(job.timer);
      this.completedJobs += 1;
      this.idle.push(worker);
      if (message.error !== undefined) {
        job.reject(new Error(message.error));
      } else if (message.result) {
        job.resolve(message.result);
      } else {
        job.reject(new Error('AI_BOT_WORKER_EMPTY_RESPONSE'));
      }
      this.drain();
    });
    worker.on('error', (error) => {
      this.restarts += 1;
      this.options.metrics?.recordWorkerRestart();
      console.error(
        `[ai-pool] worker error (restart #${this.restarts}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      this.dropWorker(worker);
    });
    worker.on('exit', (code) => {
      if (code !== 0 && !this.disposed) {
        this.restarts += 1;
        this.options.metrics?.recordWorkerRestart();
        console.error(
          `[ai-pool] worker exited with code ${code} (restart #${this.restarts})`,
        );
      }
      this.dropWorker(worker);
    });
    return worker;
  }

  private dropWorker(worker: Worker): void {
    const index = this.workers.indexOf(worker);
    if (index >= 0) this.workers.splice(index, 1);
    const idleIndex = this.idle.indexOf(worker);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    for (const [id, job] of [...this.pending.entries()]) {
      if (job.worker === worker) {
        this.pending.delete(id);
        clearTimeout(job.timer);
        if (this.disposed) {
          job.reject(new Error('AiWorkerPool disposed.'));
          continue;
        }
        const retryTimer = setTimeout(() => {
          this.pending.delete(id);
          this.timedOutJobs += 1;
          this.options.metrics?.recordTimeout();
          job.reject(new Error('AI_BOT_WATCHDOG_TIMEOUT'));
        }, this.watchdogMs());
        retryTimer.unref?.();
        this.queue.unshift({ ...job, timer: retryTimer, worker: undefined });
      }
    }
    this.drain();
  }

  private runOnWorker(worker: Worker, job: QueuedJob): void {
    job.worker = worker;
    this.pending.set(job.id, job);
    worker.postMessage({ id: job.id, mode: job.mode, input: job.input });
  }
}

export const workerEntryFor = (): string => {
  const base = import.meta.url.endsWith('.ts') ? 'worker.ts' : 'worker.js';
  return fileURLToPath(new URL(base, import.meta.url));
};

/**
 * Merge per-worker ds-search slices: sum root action statistics (mean value
 * dominates, then visits, then actionKey for determinism) and pick the move
 * from any slice's movesByKey.
 */
export const mergeDsSearchResults = (
  results: DsSearchResult[],
  seed: string,
  determinizations: number,
): BotDecision => {
  const agg = new Map<string, { visits: number; valueSum: number }>();
  const movesByKey: Record<string, BotDecision['move']> = {};
  let nodesVisited = 0;
  let elapsedMs = 0;
  let timedOut = false;
  for (const result of results) {
    Object.assign(movesByKey, result.movesByKey);
    nodesVisited += result.decision.nodesVisited;
    elapsedMs = Math.max(elapsedMs, result.decision.elapsedMs);
    timedOut = timedOut || result.decision.timedOut;
    for (const stat of result.stats) {
      const entry = agg.get(stat.actionKey);
      if (entry) {
        entry.visits += stat.visits;
        entry.valueSum += stat.valueSum;
      } else {
        agg.set(stat.actionKey, { visits: stat.visits, valueSum: stat.valueSum });
      }
    }
  }
  const ranked = [...agg.entries()].sort((left, right) => {
    const leftMean = left[1].valueSum / Math.max(1, left[1].visits);
    const rightMean = right[1].valueSum / Math.max(1, right[1].visits);
    return (
      rightMean - leftMean ||
      right[1].visits - left[1].visits ||
      left[0].localeCompare(right[0])
    );
  });
  const bestKey = ranked[0]?.[0];
  const move =
    (bestKey ? movesByKey[bestKey] : undefined) ?? results[0].decision.move;
  return {
    move,
    modelVersion: 'ai-kernel-ds-v1.0.0',
    policy: 'ds-search-v1',
    seed,
    nodesVisited,
    elapsedMs: Math.round(elapsedMs * 100) / 100,
    timedOut,
    fallbackLevel: timedOut ? 1 : 0,
    searchTrace: {
      determinizations,
      topActions: ranked.slice(0, 8).map(([actionKey, entry]) => ({
        actionKey,
        visits: entry.visits,
        valueSum: entry.valueSum,
        mean: entry.valueSum / Math.max(1, entry.visits),
      })),
    },
  };
};
