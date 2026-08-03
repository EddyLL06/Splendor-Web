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
import { computeExpertDecision } from '../../shared/ai/search/micro-mcts.js';
import type { BotDecision } from '../../shared/ai/types.js';
import type { ExpertMemorySnapshot } from '../../shared/ai/memory.js';
import type { AiMetrics } from './metrics.js';

interface QueuedJob {
  id: number;
  input: HardDecisionInput;
  mode: 'hard' | 'expert';
  priority: 'live' | 'background';
  resolve: (decision: BotDecision) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  worker?: Worker;
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
    return this.request(input, 'hard', priority);
  }

  async requestExpertDecision(
    input: HardDecisionInput & { memory?: ExpertMemorySnapshot },
    priority: 'live' | 'background' = 'live',
  ): Promise<BotDecision> {
    return this.request(input, 'expert', priority);
  }

  /**
   * The search budget only bounds compute inside the worker; worker-thread
   * startup (module/tsx loading) and IPC round-trips add time on top,
   * especially on cold CI/containers. Keep a minimum grace so the watchdog
   * never races ahead of a cold worker boot.
   */
  private watchdogMs(): number {
    return Math.max(this.options.hardMaxMs + 50, 2_000);
  }

  private async request(
    input: HardDecisionInput,
    mode: 'hard' | 'expert',
    priority: 'live' | 'background',
  ): Promise<BotDecision> {
    if (this.disposed) throw new Error('AiWorkerPool is disposed.');
    if (this.options.workerCount === 0) {
      return mode === 'hard'
        ? computeHardDecision(input)
        : computeExpertDecision(input);
    }
    if (this.queue.length + this.pending.size >= this.options.queueLimit) {
      throw new Error('AI_BOT_QUEUE_FULL');
    }
    const id = this.nextID++;
    return new Promise<BotDecision>((resolve, reject) => {
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
      this.dropWorker(worker);
    });
    worker.on('exit', (code) => {
      if (code !== 0 && !this.disposed) {
        this.restarts += 1;
        this.options.metrics?.recordWorkerRestart();
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
