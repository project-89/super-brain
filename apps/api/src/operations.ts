export type DependencyState = "ready" | "unavailable" | "unknown";

export interface DependencyObservation {
  readonly status: DependencyState;
  readonly observedAt: string;
  readonly reason?: "deadline" | "probe_failed" | "not_configured" | "closing";
}

export interface ReadinessSnapshot {
  readonly status: "ready" | "unavailable";
  readonly observedAt: string;
  readonly dependencies: Readonly<Record<string, DependencyObservation>>;
}

export interface OperationsProvider {
  readiness(): Promise<ReadinessSnapshot>;
  diagnostics?(tenant?: { readonly organizationId: string; readonly workspaceId: string }): Promise<Readonly<Record<string, unknown>>>;
  observeResponse?(status: number, elapsedMs: number): void;
}

/** A timed-out probe stays single-flight until its underlying work settles.
 * Repeated health traffic therefore cannot grow a queue of abandoned probes. */
export class BoundedDependencyProbe {
  private flight: Promise<DependencyObservation> | undefined;
  private cached: DependencyObservation | undefined;
  private checkedAt = 0;
  private closing = false;
  private controller: AbortController | undefined;

  constructor(private readonly probe: (signal: AbortSignal) => Promise<void>,
    private readonly timeoutMs = 2_000, private readonly cacheMs = 1_000) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(cacheMs) || cacheMs < 0) throw new TypeError("Invalid readiness timing");
  }

  async read(): Promise<DependencyObservation> {
    if (this.closing) return this.observation("unavailable", "closing");
    if (this.cached !== undefined && Date.now() - this.checkedAt < this.cacheMs) return this.cached;
    if (this.flight === undefined) {
      const controller = new AbortController();
      this.controller = controller;
      const work = Promise.resolve().then(() => this.probe(controller.signal));
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<DependencyObservation>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error("Readiness deadline exceeded"));
          resolve(this.observation("unavailable", "deadline"));
        }, this.timeoutMs);
      });
      const settled = work.then(
        () => this.observation(timedOut ? "unavailable" : "ready", timedOut ? "deadline" : undefined),
        () => this.observation("unavailable", timedOut ? "deadline" : "probe_failed"),
      ).then((result) => {
        if (timer !== undefined) clearTimeout(timer);
        this.cached = result;
        this.checkedAt = Date.now();
        this.flight = undefined;
        this.controller = undefined;
        return result;
      });
      this.flight = Promise.race([settled, deadline]);
    }
    return this.flight;
  }

  close(): void { this.closing = true; this.controller?.abort(new Error("Readiness is closing")); }
  private observation(status: DependencyState, reason?: DependencyObservation["reason"]): DependencyObservation {
    return { status, observedAt: new Date().toISOString(), ...(reason === undefined ? {} : { reason }) };
  }
}

export class ApiOperations implements OperationsProvider {
  private readonly startedAt = new Date().toISOString();
  private requests = 0;
  private errors = 0;
  private limited = 0;
  private readonly durationBuckets = [0, 0, 0, 0, 0];

  constructor(private readonly required: Readonly<Record<string, BoundedDependencyProbe>>,
    private readonly optional: Readonly<Record<string, BoundedDependencyProbe | undefined>> = {},
    private readonly tenantDiagnostics?: (tenant: { readonly organizationId: string; readonly workspaceId: string }) => Promise<Readonly<Record<string, unknown>>>) {}

  async readiness(): Promise<ReadinessSnapshot> {
    const entries = await Promise.all(Object.entries(this.required).map(async ([name, probe]) => [name, await probe.read()] as const));
    return { status: entries.every(([, state]) => state.status === "ready") ? "ready" : "unavailable",
      observedAt: new Date().toISOString(), dependencies: Object.fromEntries(entries) };
  }

  observeResponse(status: number, elapsedMs: number): void {
    this.requests += 1;
    if (status >= 500) this.errors += 1;
    if (status === 429) this.limited += 1;
    const index = elapsedMs <= 100 ? 0 : elapsedMs <= 500 ? 1 : elapsedMs <= 2_000 ? 2 : elapsedMs <= 10_000 ? 3 : 4;
    this.durationBuckets[index]! += 1;
  }

  async diagnostics(tenant?: { readonly organizationId: string; readonly workspaceId: string }): Promise<Readonly<Record<string, unknown>>> {
    const optional = await Promise.all(Object.entries(this.optional).map(async ([name, probe]) => [name,
      probe === undefined ? { status: "unknown", reason: "not_configured", observedAt: new Date().toISOString() } : await probe.read()]));
    const processing = tenant === undefined || this.tenantDiagnostics === undefined ? { status: "unknown", reason: "not_configured" }
      : await this.tenantDiagnostics(tenant).catch(() => ({ status: "unavailable", reason: "probe_failed" }));
    return { version: 1, startedAt: this.startedAt, readiness: await this.readiness(), optional: Object.fromEntries(optional), processing,
      requests: this.requests, errors: this.errors, limited: this.limited,
      requestDurationMs: { upperBounds: [100, 500, 2_000, 10_000, null], counts: [...this.durationBuckets] } };
  }

  close(): void { for (const probe of [...Object.values(this.required), ...Object.values(this.optional)]) probe?.close(); }
}
