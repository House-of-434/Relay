/** Small, dependency-free concurrency and caching helpers for the research
 * connectors. In-memory only: nothing here is a second persistence system. */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serialize async work and keep a minimum gap between starts. arXiv asks
 * callers to space requests by a few seconds; this enforces that without a
 * shared timer. Failures do not poison the chain. */
export class SerialGate {
  private tail: Promise<void> = Promise.resolve();
  private lastStarted = 0;

  constructor(private readonly minIntervalMs: number) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastStarted);
      if (wait > 0) await sleep(wait);
      try {
        return await task();
      } finally {
        this.lastStarted = Date.now();
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Token-bucket rate limiter. SEC EDGAR asks for no more than 10 requests per
 * second; this makes the connector a good citizen regardless of how busy the
 * agents are. */
export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();

  constructor(
    private readonly ratePerSecond: number,
    private readonly burst = Math.max(1, Math.floor(ratePerSecond)),
  ) {
    this.tokens = burst;
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      const elapsed = (now - this.lastRefill) / 1000;
      if (elapsed > 0) {
        this.tokens = Math.min(this.burst, this.tokens + elapsed * this.ratePerSecond);
        this.lastRefill = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.ratePerSecond) * 1000));
    }
  }
}

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

/** Bounded TTL cache keyed by an arbitrary string. Used for SEC company
 * metadata and connector state lookups so repeat calls stay cheap. */
export class TtlCache<V> {
  private readonly entries = new Map<string, CacheEntry<V>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
  ) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Refresh recency for a simple LRU eviction order.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  async getOrSet(key: string, factory: () => Promise<V>): Promise<V> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await factory();
    this.set(key, value);
    return value;
  }
}
