import { describe, expect, it } from "vitest";

import { FixedWindowRateLimiter } from "../src/index.js";

describe("fixed-window request limiter", () => {
  it("limits each key and resets on the next window", () => {
    const limiter = new FixedWindowRateLimiter(2, 1_000);
    expect(limiter.consume("client-a", 100)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume("client-a", 200)).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.consume("client-a", 300)).toEqual({
      allowed: false,
      limit: 2,
      remaining: 0,
      resetAt: 1_000,
      retryAfterSeconds: 1,
    });
    expect(limiter.consume("client-b", 300)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.consume("client-a", 1_000)).toMatchObject({
      allowed: true,
      remaining: 1,
      resetAt: 2_000,
    });
  });

  it("bounds tracked client keys", () => {
    const limiter = new FixedWindowRateLimiter(1, 1_000, 2);
    limiter.consume("client-a", 100);
    limiter.consume("client-b", 100);
    limiter.consume("client-c", 100);
    expect(limiter.consume("client-a", 100)).toMatchObject({ allowed: true });
  });

  it("rejects invalid configuration and input", () => {
    expect(() => new FixedWindowRateLimiter(0)).toThrow(/positive integer/);
    expect(() => new FixedWindowRateLimiter(1, 0)).toThrow(/positive integer/);
    expect(() => new FixedWindowRateLimiter(1, 1_000, 0)).toThrow(/positive integer/);
    const limiter = new FixedWindowRateLimiter(1);
    expect(() => limiter.consume("")).toThrow(/must not be empty/);
    expect(() => limiter.consume("client", -1)).toThrow(/non-negative/);
  });
});
