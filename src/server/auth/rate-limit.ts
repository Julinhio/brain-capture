/**
 * Fixed-window limiter kept in memory. One app instance serves one person, so there is
 * nothing to share across processes; a restart resetting the counters is acceptable.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true when the attempt is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      this.prune(t);
      return true;
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private prune(t: number): void {
    if (this.hits.size < 1000) return;
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
