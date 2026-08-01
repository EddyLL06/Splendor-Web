import { ApiError } from '../errors.js';

interface Bucket {
  timestamps: number[];
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  consume(
    key: string,
    options: { limit: number; windowMs: number },
    now = Date.now(),
  ): void {
    const cutoff = now - options.windowMs;
    const bucket = this.buckets.get(key) ?? { timestamps: [] };
    bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp > cutoff);
    if (bucket.timestamps.length >= options.limit) {
      this.buckets.set(key, bucket);
      throw new ApiError(429, 'RATE_LIMITED');
    }
    bucket.timestamps.push(now);
    this.buckets.set(key, bucket);
  }

  clear(): void {
    this.buckets.clear();
  }
}
