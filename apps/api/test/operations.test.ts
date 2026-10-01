import { describe, expect, it, vi } from "vitest";
import { ApiOperations, BoundedDependencyProbe } from "../src/operations.js";
import { StaticIdentityDirectory } from "../src/auth.js";
import { FixedWindowRateLimiter } from "../src/rate-limit.js";
import { postgresStartupPolicy } from "../src/environment.js";
import { apiRequest, startApi } from "./helpers.js";

describe("bounded operational readiness", () => {
  it("keeps a timed-out probe single-flight until it settles and then recovers", async () => {
    let settle!: () => void;
    let observedSignal: AbortSignal | undefined;
    const probe = vi.fn(async (signal: AbortSignal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => { settle = resolve; });
    });
    const bounded = new BoundedDependencyProbe(probe, 10, 0);
    const first = await Promise.all(Array.from({ length: 20 }, () => bounded.read()));
    expect(first.every((item) => item.status === "unavailable" && item.reason === "deadline")).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(observedSignal?.aborted).toBe(true);
    await Promise.all(Array.from({ length: 20 }, () => bounded.read()));
    expect(probe).toHaveBeenCalledTimes(1);
    settle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    probe.mockResolvedValueOnce(undefined);
    expect((await bounded.read()).status).toBe("ready");
    expect(probe).toHaveBeenCalledTimes(2);
    bounded.close();
    expect((await bounded.read()).reason).toBe("closing");
  });

  it("keeps liveness public, dependency details private, and absent workers unknown", async () => {
    const operations = new ApiOperations({ database: new BoundedDependencyProbe(async () => { throw new Error("private database config"); }) }, { worker: undefined });
    const api = await startApi({ operations });
    try {
      expect((await apiRequest(api.baseUrl, "/health")).status).toBe(200);
      expect(await apiRequest(api.baseUrl, "/ready")).toMatchObject({ status: 503, body: { status: "unavailable" } });
      const denied = await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/operations", { token: "token-a" });
      expect(denied.status).toBe(403);
      expect(JSON.stringify(denied.body)).not.toContain("private database config");
      expect(await operations.diagnostics()).toMatchObject({ optional: { worker: { status: "unknown" } } });
    } finally { operations.close(); await api.close(); }
  });

  it("requires explicit bootstrap for membership seeding in runtime mode", () => {
    expect(postgresStartupPolicy("serve", { FOLD_POSTGRES_SCHEMA_MODE: "verify" })).toEqual({ schemaMode: "verify", seedMemberships: false });
    expect(() => postgresStartupPolicy("serve", { FOLD_POSTGRES_SCHEMA_MODE: "verify", FOLD_API_SEED_MEMBERSHIPS: "true" })).toThrow(/cannot reseed/);
    expect(postgresStartupPolicy("migrate", {})).toEqual({ schemaMode: "migrate", seedMemberships: false });
    expect(postgresStartupPolicy("bootstrap", {})).toEqual({ schemaMode: "migrate", seedMemberships: true });
    expect(postgresStartupPolicy("serve", {})).toEqual({ schemaMode: "migrate", seedMemberships: true });
  });

  it("binds budgets to the principal across rotated credentials and caps a shared tenant", async () => {
    const record = (principalId: string) => ({ principalId, workspaces: { "workspace-1": { role: "member" as const } } });
    const directory = new StaticIdentityDirectory({ first: record("one"), rotated: record("one"), second: record("two") });
    const api = await startApi({ authenticator: directory, memberships: directory, principalRateLimiter: new FixedWindowRateLimiter(1), tenantRateLimiter: new FixedWindowRateLimiter(1) });
    try {
      const path = "/v1/workspaces/workspace-1/events";
      expect((await apiRequest(api.baseUrl, path, { token: "first" })).status).toBe(200);
      expect((await apiRequest(api.baseUrl, path, { token: "rotated" })).status).toBe(429);
      expect((await apiRequest(api.baseUrl, path, { token: "second" })).status).toBe(429);
    } finally { await api.close(); }
  });

  it("releases the tenant stream slot after disconnect", async () => {
    const api = await startApi({ eventStreamMaxPerTenant: 1 });
    const path = `${api.baseUrl}/v1/workspaces/workspace-1/event-stream`;
    let first: Response | undefined; let replacement: Response | undefined;
    try {
      first = await fetch(path, { headers: { authorization: "Bearer token-a" } });
      expect(first.status).toBe(200);
      expect((await fetch(path, { headers: { authorization: "Bearer token-b" } })).status).toBe(429);
      await first.body?.cancel(); first = undefined;
      await new Promise((resolve) => setTimeout(resolve, 20));
      replacement = await fetch(path, { headers: { authorization: "Bearer token-b" } });
      expect(replacement.status).toBe(200);
    } finally { await first?.body?.cancel(); await replacement?.body?.cancel(); await api.close(); }
  });
});
