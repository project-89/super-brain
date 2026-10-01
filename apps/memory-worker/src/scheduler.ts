import { parseEvent, type FoldEvent } from "@_89/fold";
import { ProcessingBackpressureError, processingDigest, type DurableWorkerJobs } from "./jobs.js";

/** The scheduler checkpoints inside the worker's leased, encrypted job ledger. */
export type SchedulerStateStore = Pick<DurableWorkerJobs, "readSchedulerState" | "writeSchedulerState">;

export interface ScheduledSource {
  readonly eventId: string;
  readonly digest: string;
  readonly sequence?: string;
  readonly sourceTime: number;
}
export interface SchedulingWindow {
  readonly version: 1;
  readonly id: string;
  readonly policy: string;
  readonly partition: string;
  readonly projectId?: string;
  readonly parentWindowId?: string;
  readonly trigger: "count" | "elapsed" | "completion" | "capacity" | "manual";
  readonly openedAt: number;
  readonly sealedAt: number;
  readonly sources: readonly ScheduledSource[];
}
interface OpenWindow {
  partition: string;
  projectId?: string;
  openedAt: number;
  sources: ScheduledSource[];
  anchor: FoldEvent;
}
interface SchedulerState {
  version: 1;
  policy: string;
  through: string;
  excluded: number;
  windows: OpenWindow[];
  outbox: { window: SchedulingWindow; anchor: FoldEvent }[];
}
const digestValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const counterValid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const sequenceValid = (value: unknown): value is string => typeof value === "string" && /^(?:0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= 9223372036854775807n;
function sourcesValid(sources: unknown): sources is ScheduledSource[] {
  return Array.isArray(sources) && sources.length > 0 && sources.length <= 1_000 && sources.every((source, index) => source !== null &&
    typeof source.eventId === "string" && source.eventId.length > 0 && digestValid(source.digest) && (source.sequence === undefined || sequenceValid(source.sequence)) &&
    typeof source.sourceTime === "number" && Number.isFinite(source.sourceTime) &&
    (index === 0 || source.sequence === undefined || sources[index - 1].sequence === undefined || BigInt(source.sequence) > BigInt(sources[index - 1].sequence))) && new Set(sources.map(source => source.eventId)).size === sources.length;
}
export function validateSchedulingWindow(value: unknown): asserts value is SchedulingWindow {
  const item = value as SchedulingWindow | undefined;
  if (item === undefined || item === null || item.version !== 1 || !digestValid(item.id) || !digestValid(item.policy) || !digestValid(item.partition) ||
    (item.projectId !== undefined && (typeof item.projectId !== "string" || item.projectId.length === 0)) || (item.parentWindowId !== undefined && !digestValid(item.parentWindowId)) ||
    !["count", "elapsed", "completion", "capacity", "manual"].includes(item.trigger) || !counterValid(item.openedAt) || !counterValid(item.sealedAt) || item.sealedAt < item.openedAt || !sourcesValid(item.sources) ||
    (item.trigger !== "manual" && item.parentWindowId === undefined && item.sources.some(source => source.sequence === undefined))) {
    throw new Error("Invalid scheduling window; preserved state requires inspection");
  }
  const { id, ...identity } = item;
  if (processingDigest(identity) !== id) throw new Error("Scheduling window identity does not match its evidence");
}
function validateState(value: unknown, policy: string): asserts value is SchedulerState {
  const state = value as SchedulerState | undefined;
  if (state === null || state === undefined || state.version !== 1 || state.policy !== policy || !sequenceValid(state.through) || !counterValid(state.excluded) ||
    !Array.isArray(state.windows) || state.windows.length > 1_000 || !Array.isArray(state.outbox) || state.outbox.length > 1_000) throw new Error("Invalid durable scheduler state; inspect preserved checkpoint");
  if (new Set(state.windows.map(window => window.partition)).size !== state.windows.length) throw new Error("Duplicate scheduler partition");
  for (const window of state.windows) {
    if (window === null || !digestValid(window.partition) || !counterValid(window.openedAt) || !sourcesValid(window.sources) || (window.projectId !== undefined && (typeof window.projectId !== "string" || window.projectId.length === 0))) throw new Error("Invalid open scheduling window");
    parseEvent(window.anchor);
    if (window.anchor.id !== window.sources.at(-1)!.eventId || processingDigest(window.anchor) !== window.sources.at(-1)!.digest) throw new Error("Invalid scheduler source anchor");
    if (window.sources.some(source => source.sequence === undefined) || BigInt(window.sources.at(-1)!.sequence!) > BigInt(state.through)) throw new Error("Scheduler source is beyond checkpoint");
  }
  for (const item of state.outbox) {
    validateSchedulingWindow(item.window); parseEvent(item.anchor);
    if (item.window.policy !== policy || item.anchor.id !== item.window.sources.at(-1)!.eventId || processingDigest(item.anchor) !== item.window.sources.at(-1)!.digest || item.window.sources.some(source => source.sequence === undefined) || BigInt(item.window.sources.at(-1)!.sequence!) > BigInt(state.through)) throw new Error("Invalid scheduler outbox provenance");
  }
}

export async function readSchedulingCoverage(store: SchedulerStateStore & Pick<DurableWorkerJobs, "schedulerStateIds">) {
  const summaries = [];
  for (const id of await store.schedulerStateIds()) {
    const state: unknown = await store.readSchedulerState(id);
    validateState(state, id);
    summaries.push({ policy: state.policy, through: state.through, excludedSources: state.excluded,
      openWindows: state.windows.length, openSources: state.windows.reduce((total, window) => total + window.sources.length, 0),
      pendingWindows: state.outbox.length, pendingSources: state.outbox.reduce((total, item) => total + item.window.sources.length, 0) });
  }
  return summaries;
}

/** Atomic state + outbox under the spool lease; transport acknowledgements follow durable observation. */
export class DurableWindowScheduler {
  private state: SchedulerState | undefined;
  private serial: Promise<unknown> = Promise.resolve();
  constructor(private readonly store: SchedulerStateStore, readonly policy: string, private readonly options: {
    readonly every: number; readonly elapsedMs: number; readonly capacity?: number;
    readonly deliver: (window: SchedulingWindow, anchor: FoldEvent) => Promise<unknown>;
  }) {
    if (!digestValid(policy) || !Number.isInteger(options.every) || options.every < 1 || options.every > 100_000 || !Number.isSafeInteger(options.elapsedMs) || options.elapsedMs < 1 || options.elapsedMs > 86_400_000 || !Number.isInteger(options.capacity ?? 1_000) || (options.capacity ?? 1_000) < 1 || (options.capacity ?? 1_000) > 1_000) throw new TypeError("Invalid scheduling policy");
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation);
    this.serial = result.catch(() => undefined);
    return result;
  }
  async open(initialSequence: string): Promise<void> {
    if (!sequenceValid(initialSequence)) throw new TypeError("Invalid scheduler starting ingestion sequence");
    const existing = await this.store.readSchedulerState(this.policy);
    if (existing !== undefined) { validateState(existing, this.policy); this.state = existing; }
    else {
      const state: SchedulerState = { version: 1, policy: this.policy, through: initialSequence, excluded: 0, windows: [], outbox: [] };
      await this.persist(state);
    }
    await this.flush();
  }
  private async persist(state: SchedulerState, admission = false): Promise<void> {
    validateState(state, this.policy);
    // Admission reserves 1 MiB for sealing metadata across at most 1,000 windows.
    if (state.windows.reduce((total, window) => total + window.sources.length, 0) + state.outbox.reduce((total, item) => total + item.window.sources.length, 0) > 10_000 || Buffer.byteLength(JSON.stringify(state), "utf8") > (admission ? 15 : 16) * 1024 * 1024) {
      throw new ProcessingBackpressureError("Scheduler state capacity reached; transport checkpoint unchanged");
    }
    await this.store.writeSchedulerState(this.policy, state);
    this.state = state;
  }
  private seal(state: SchedulerState, window: OpenWindow, trigger: SchedulingWindow["trigger"], now: number): void {
    if (state.outbox.length >= 1_000) throw new ProcessingBackpressureError("Scheduler outbox capacity reached; transport checkpoint unchanged");
    const identity = { version: 1 as const, policy: this.policy, partition: window.partition, ...(window.projectId === undefined ? {} : { projectId: window.projectId }), trigger, openedAt: window.openedAt, sealedAt: Math.max(now, window.openedAt), sources: window.sources };
    state.outbox.push({ window: { ...identity, id: processingDigest(identity) }, anchor: window.anchor });
    state.windows = state.windows.filter(item => item !== window);
  }
  private async flush(): Promise<void> {
    if (this.state === undefined) throw new Error("Open scheduler before use");
    while (this.state.outbox.length > 0) {
      const item = this.state.outbox[0]!;
      try { await this.options.deliver(item.window, item.anchor); }
      catch (error) {
        // The durable outbox owns this work already. Let processing free queue
        // capacity instead of preventing startup or stopping the drain pump.
        if (error instanceof ProcessingBackpressureError) return;
        throw error;
      }
      await this.persist({ ...this.state, outbox: this.state.outbox.slice(1) });
    }
  }
  observe(sequence: string, source?: { event: FoldEvent; partition: string; projectId?: string; completion?: boolean }, now = Date.now(), excluded = false): Promise<void> {
    return this.serialize(async () => {
      if (this.state === undefined || !sequenceValid(sequence) || !counterValid(now)) throw new Error("Invalid scheduler observation");
      await this.flush();
      if (BigInt(sequence) <= BigInt(this.state.through)) return;
      if (source === undefined && !excluded) return;
      const state: SchedulerState = structuredClone(this.state);
      state.through = sequence;
      if (excluded) state.excluded++;
      if (source !== undefined) {
        if (!digestValid(source.partition)) throw new Error("Invalid scheduler partition");
        let window = state.windows.find(item => item.partition === source.partition);
        if (window !== undefined && now >= window.openedAt + this.options.elapsedMs) { this.seal(state, window, "elapsed", now); window = undefined; }
        if (window === undefined) {
          if (state.windows.length >= 1_000) throw new ProcessingBackpressureError("Scheduler partition capacity reached; transport checkpoint unchanged");
          window = { partition: source.partition, ...(source.projectId === undefined ? {} : { projectId: source.projectId }), openedAt: now, sources: [], anchor: source.event }; state.windows.push(window);
        }
        if (window.projectId !== source.projectId) throw new Error("Scheduler partition publication scope changed");
        window.sources.push({ eventId: source.event.id, digest: processingDigest(source.event), sequence, sourceTime: source.event.at.t });
        window.anchor = source.event;
        if (source.completion) this.seal(state, window, "completion", now);
        else if (window.sources.length >= this.options.every) this.seal(state, window, "count", now);
        else if (window.sources.length >= (this.options.capacity ?? 1_000)) this.seal(state, window, "capacity", now);
      }
      await this.persist(state, true);
      await this.flush();
    });
  }
  tick(now = Date.now()): Promise<void> {
    return this.serialize(async () => {
      if (this.state === undefined || !counterValid(now)) throw new Error("Invalid scheduler timer");
      await this.flush();
      const state = structuredClone(this.state);
      try {
        for (const window of [...state.windows]) if (now >= window.openedAt + this.options.elapsedMs) this.seal(state, window, "elapsed", now);
        if (state.outbox.length > 0) await this.persist(state);
      } catch (error) {
        if (error instanceof ProcessingBackpressureError) return;
        throw error;
      }
      await this.flush();
    });
  }
}
