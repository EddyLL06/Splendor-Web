/**
 * Bounded, aggregate-only AI metrics (DEVELOPMENT_GUIDE.md §17). No match
 * state, card IDs, credentials or secrets are ever stored here.
 */

export class AiMetrics {
  private decisions = 0;
  private decisionDurationsMs: number[] = [];
  private timeouts = 0;
  private fallbacks = 0;
  private noLegalActions = 0;
  private staleResults = 0;
  private queueDepthPeak = 0;
  private workerRestarts = 0;
  private readonly durationWindow = 4096;

  recordDecision(durationMs: number, difficulty: string): void {
    this.decisions += 1;
    this.decisionDurationsMs.push(durationMs);
    if (this.decisionDurationsMs.length > this.durationWindow) {
      this.decisionDurationsMs.shift();
    }
  }

  recordTimeout(): void {
    this.timeouts += 1;
  }

  recordFallback(from: string): void {
    this.fallbacks += 1;
  }

  recordNoLegalAction(): void {
    this.noLegalActions += 1;
  }

  recordStaleResult(): void {
    this.staleResults += 1;
  }

  recordQueueDepth(depth: number): void {
    if (depth > this.queueDepthPeak) this.queueDepthPeak = depth;
  }

  recordWorkerRestart(): void {
    this.workerRestarts += 1;
  }

  snapshot(): {
    decisions: number;
    decisionP50Ms: number;
    decisionP95Ms: number;
    decisionP99Ms: number;
    timeouts: number;
    fallbacks: number;
    noLegalActions: number;
    staleResults: number;
    queueDepthPeak: number;
    workerRestarts: number;
  } {
    const values = [...this.decisionDurationsMs].sort(
      (left, right) => left - right,
    );
    const percentile = (p: number): number =>
      values.length === 0
        ? 0
        : values[Math.min(values.length - 1, Math.ceil((p / 100) * values.length) - 1)];
    return {
      decisions: this.decisions,
      decisionP50Ms: Math.round(percentile(50) * 100) / 100,
      decisionP95Ms: Math.round(percentile(95) * 100) / 100,
      decisionP99Ms: Math.round(percentile(99) * 100) / 100,
      timeouts: this.timeouts,
      fallbacks: this.fallbacks,
      noLegalActions: this.noLegalActions,
      staleResults: this.staleResults,
      queueDepthPeak: this.queueDepthPeak,
      workerRestarts: this.workerRestarts,
    };
  }
}
