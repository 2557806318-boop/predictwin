import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

/** Pass the USABLE budget after reserving capacity for other services on the IP. */
export class TokenBucket {
  constructor(capacity, now = () => performance.now()) {
    if (!Number.isFinite(capacity) || capacity <= 0) throw new RangeError('Invalid capacity');
    this.capacity = capacity;
    this.tokens = capacity;
    this.now = now;
    this.last = now();
  }
  refill() {
    const now = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.last) * this.capacity / 60_000);
    this.last = now;
  }
  async acquire(weight, { maxWaitMs = 500, signal } = {}) {
    if (!Number.isFinite(weight) || weight <= 0 || weight > this.capacity || !Number.isFinite(maxWaitMs) || maxWaitMs < 0) {
      throw new RangeError('Invalid request budget');
    }
    const start = this.now();
    for (;;) {
      signal?.throwIfAborted();
      this.refill();
      if (this.tokens >= weight) { this.tokens -= weight; return this.now() - start; }
      const wait = (weight - this.tokens) * 60_000 / this.capacity;
      if (this.now() - start + wait > maxWaitMs) throw new Error('RATE_LIMIT_BUDGET_UNAVAILABLE');
      await sleep(Math.min(100, Math.max(1, wait)), undefined, { signal });
    }
  }
}
