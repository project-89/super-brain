export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
  readonly resetAt: number;
  readonly retryAfterSeconds?: number;
}

export interface RequestRateLimiter {
  consume(key: string, nowMs?: number): RateLimitDecision;
}

interface FixedWindow {
  readonly startedAt: number;
  count: number;
}

export class FixedWindowRateLimiter implements RequestRateLimiter {
  private readonly windows = new Map<string, FixedWindow>();

  constructor(
    readonly limit: number,
    readonly windowMs = 60_000,
    readonly maxKeys = 10_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError("rate limit must be a positive integer");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new TypeError("rate-limit window must be a positive integer");
    }
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new TypeError("rate-limit key capacity must be a positive integer");
    }
  }

  consume(key: string, nowMs = Date.now()): RateLimitDecision {
    if (key.length === 0) throw new TypeError("rate-limit key must not be empty");
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new TypeError("rate-limit time must be a finite non-negative number");
    }

    const startedAt = Math.floor(nowMs / this.windowMs) * this.windowMs;
    let window = this.windows.get(key);
    if (window === undefined || window.startedAt !== startedAt) {
      this.expireAndMakeRoom(startedAt);
      window = { startedAt, count: 0 };
      this.windows.set(key, window);
    }

    const resetAt = startedAt + this.windowMs;
    if (window.count >= this.limit) {
      return {
        allowed: false,
        limit: this.limit,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.max(1, Math.ceil((resetAt - nowMs) / 1_000)),
      };
    }

    window.count += 1;
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - window.count,
      resetAt,
    };
  }

  private expireAndMakeRoom(currentWindowStart: number): void {
    for (const [key, window] of this.windows) {
      if (window.startedAt < currentWindowStart) this.windows.delete(key);
    }
    while (this.windows.size >= this.maxKeys) {
      const oldestKey = this.windows.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      this.windows.delete(oldestKey);
    }
  }
}
