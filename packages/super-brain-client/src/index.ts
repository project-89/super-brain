import type { FoldEvent, FoldLogEntry } from "@_89/fold";
import type {
  MemoryAudience,
  MemoryCandidateInput,
  MemoryCandidateView,
  MemoryInput,
  PersonalMemory,
  RecallRequest,
  RecalledMemory,
} from "@_89/fold-epistemic";
import type { FoldSdkCursor, RankedMemoryRecallResult } from "@_89/fold-sdk";
import type { TranscriptRun } from "@_89/fold-transcript";
import type {
  TrajectoryInput,
  TrajectoryMutationResult,
  TrajectoryTreeMutationResult,
  TrajectoryTreeRecord,
} from "@_89/fold-trajectory";

export interface SuperBrainClientOptions {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export interface EventStamp {
  readonly id: string;
  readonly t: number;
  readonly worldDate: string;
}

export interface StreamedFoldEvent {
  readonly entry: FoldLogEntry;
  readonly cursor: FoldSdkCursor;
}

export interface EventStreamOptions {
  readonly after?: FoldSdkCursor;
  readonly replay?: "tail" | "all";
  readonly include?: "canon" | "canon+draft";
  readonly kinds?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface ConsumeEventOptions extends Omit<EventStreamOptions, "after" | "replay"> {
  readonly consumerId: string;
  readonly replay?: "tail" | "all";
  readonly reconnect?: boolean;
  readonly reconnectDelayMs?: number;
  readonly onEvent: (event: StreamedFoldEvent) => void | Promise<void>;
}

export class SuperBrainApiError extends Error {
  override readonly name = "SuperBrainApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

let lastStampTime = -1;
let stampSequence = 0;

function localWorldDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear().toString().padStart(4, "0");
  const month = (date.getMonth() + 1).toString().padStart(2, "0");
  const day = date.getDate().toString().padStart(2, "0");
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function uuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new TypeError("UUIDv7 timestamp must be a non-negative 48-bit integer");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nextEventStamp(now = Date.now(), producer = "harness"): EventStamp {
  const t = Math.max(now, lastStampTime);
  if (t === lastStampTime) stampSequence += 1;
  else {
    lastStampTime = t;
    stampSequence = 0;
  }
  return {
    id: `${producer}-${t.toString().padStart(13, "0")}-${stampSequence.toString().padStart(4, "0")}`,
    t,
    worldDate: localWorldDate(t),
  };
}

function appendRepeated(params: URLSearchParams, key: string, values?: readonly string[]): void {
  values?.forEach((value) => {
    const normalized = value.trim();
    if (normalized.length > 0) params.append(key, normalized);
  });
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class SuperBrainClient {
  private readonly baseUrl: string;
  private readonly workspaceId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SuperBrainClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.workspaceId = options.workspaceId.trim();
    this.token = options.token.trim();
    this.fetchImpl = options.fetch ?? fetch;
    if (this.baseUrl.length === 0 || this.workspaceId.length === 0 || this.token.length === 0) {
      throw new TypeError("baseUrl, workspaceId, and token are required");
    }
  }

  private workspacePath(resource: string): string {
    return `/v1/workspaces/${encodeURIComponent(this.workspaceId)}/${resource}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const body = await response.json().catch(() => ({})) as {
      readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown };
    };
    if (!response.ok) {
      throw new SuperBrainApiError(
        response.status,
        body.error?.code ?? "request_failed",
        body.error?.message ?? `Super Brain request failed with HTTP ${response.status}`,
        body.error?.details,
      );
    }
    return body as T;
  }

  appendEvent(event: FoldEvent, status: "canon" | "draft" = "canon") {
    return this.request<{ readonly entry: FoldLogEntry }>(this.workspacePath("events"), {
      method: "POST",
      body: JSON.stringify({ event, status }),
    });
  }

  async listEvents(options: { readonly kinds?: readonly string[]; readonly include?: "canon" | "canon+draft"; readonly limit?: number } = {}): Promise<readonly FoldLogEntry[]> {
    const params = new URLSearchParams();
    appendRepeated(params, "kind", options.kinds);
    if (options.include !== undefined) params.set("include", options.include);
    if (options.limit !== undefined) params.set("limit", options.limit.toString());
    const response = await this.request<{ readonly entries: readonly FoldLogEntry[] }>(
      `${this.workspacePath("events")}${params.size === 0 ? "" : `?${params}`}`,
    );
    return response.entries;
  }

  async transcriptRuns(): Promise<readonly TranscriptRun[]> {
    const response = await this.request<{ readonly runs: readonly TranscriptRun[] }>(this.workspacePath("transcript-runs"));
    return response.runs;
  }

  recordTrajectoryTree(
    stamp: EventStamp,
    tree: TrajectoryTreeRecord["tree"],
    options: { readonly spaceId?: string; readonly captureIdentity?: Readonly<Record<string, string>> } = {},
  ): Promise<TrajectoryTreeMutationResult> {
    return this.request(this.workspacePath("trajectory-tasks"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        tree,
        ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
        ...(options.captureIdentity === undefined ? {} : { captureIdentity: options.captureIdentity }),
      }),
    });
  }

  recordTrajectory(
    stamp: EventStamp,
    input: TrajectoryInput,
    options: { readonly spaceId?: string; readonly captureIdentity?: Readonly<Record<string, string>> } = {},
  ): Promise<TrajectoryMutationResult> {
    return this.request(this.workspacePath("trajectories"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        input,
        ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
        ...(options.captureIdentity === undefined ? {} : { captureIdentity: options.captureIdentity }),
      }),
    });
  }

  recallMemories(request: Omit<RecallRequest, "candidates"> = {}): Promise<{ readonly memories: readonly RecalledMemory[] }> {
    return this.request(this.workspacePath("memories/recall"), { method: "POST", body: JSON.stringify(request) });
  }

  rankMemories(request: Omit<RecallRequest, "candidates"> & { readonly query: string }): Promise<RankedMemoryRecallResult> {
    return this.request(this.workspacePath("memories/search"), { method: "POST", body: JSON.stringify(request) });
  }

  recordMemory(input: Omit<MemoryInput, "id"> & { readonly id?: string }, causedBy?: readonly string[]) {
    const stamp = nextEventStamp();
    return this.request<{ readonly event: FoldEvent; readonly memory: PersonalMemory }>(this.workspacePath("memories"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        input: { ...input, id: input.id ?? uuidV7(stamp.t) },
        ...(causedBy === undefined ? {} : { causedBy }),
      }),
    });
  }

  proposeMemoryCandidate(
    input: Omit<MemoryCandidateInput, "id"> & { readonly id?: string },
    causedBy?: readonly string[],
  ) {
    const stamp = nextEventStamp();
    return this.request(this.workspacePath("memory-candidates"), {
      method: "POST",
      body: JSON.stringify({
        stamp,
        input: { ...input, id: input.id ?? uuidV7(stamp.t) },
        ...(causedBy === undefined ? {} : { causedBy }),
      }),
    });
  }

  proposeMemoryCandidates(
    inputs: readonly (Omit<MemoryCandidateInput, "id" | "audience" | "spaceId"> & { readonly id?: string })[],
    options: { readonly audience?: MemoryAudience; readonly spaceId?: string } = {},
  ) {
    const audience = options.audience ?? "workspace";
    const proposals = inputs.map((input) => {
      const stamp = nextEventStamp();
      return {
        stamp,
        input: {
          ...input,
          id: input.id ?? uuidV7(stamp.t),
          audience,
          ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
        },
      };
    });
    return this.request(this.workspacePath("memory-candidate-imports"), {
      method: "POST",
      body: JSON.stringify({ audience, ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }), proposals }),
    });
  }

  async memoryCandidates(options: {
    readonly status?: MemoryCandidateView["status"];
    readonly projectIds?: readonly string[];
    readonly offset?: number;
    readonly limit?: number;
  } = {}): Promise<readonly MemoryCandidateView[]> {
    const params = new URLSearchParams();
    if (options.status !== undefined) params.set("status", options.status);
    appendRepeated(params, "projectId", options.projectIds);
    if (options.offset !== undefined) params.set("offset", options.offset.toString());
    if (options.limit !== undefined) params.set("limit", options.limit.toString());
    const response = await this.request<{ readonly candidates: readonly MemoryCandidateView[] }>(
      `${this.workspacePath("memory-candidates")}${params.size === 0 ? "" : `?${params}`}`,
    );
    return response.candidates;
  }

  acceptMemoryCandidate(candidateId: string, options: { readonly memoryId?: string } = {}) {
    const stamp = nextEventStamp();
    const memoryStamp = nextEventStamp(stamp.t + 1);
    return this.request(`${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/accept`, {
      method: "POST",
      body: JSON.stringify({ stamp, memoryStamp, memoryId: options.memoryId ?? uuidV7(memoryStamp.t) }),
    });
  }

  acceptMemoryCandidates(
    candidateIds: readonly string[],
    options: { readonly audience?: MemoryAudience; readonly spaceId?: string } = {},
  ) {
    if (candidateIds.length < 1 || candidateIds.length > 100) {
      throw new TypeError("candidateIds must contain 1 to 100 IDs");
    }
    const acceptances = candidateIds.map((candidateId) => {
      const stamp = nextEventStamp();
      const memoryStamp = nextEventStamp(stamp.t + 1);
      return { candidateId, stamp, memoryStamp, memoryId: uuidV7(memoryStamp.t) };
    });
    return this.request<{ readonly accepted: readonly { readonly memory: PersonalMemory }[] }>(
      this.workspacePath("memory-candidate-promotions"),
      {
        method: "POST",
        body: JSON.stringify({
          audience: options.audience ?? "workspace",
          ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
          acceptances,
        }),
      },
    );
  }

  rejectMemoryCandidate(candidateId: string, reason: string) {
    return this.request(`${this.workspacePath("memory-candidates")}/${encodeURIComponent(candidateId)}/reject`, {
      method: "POST",
      body: JSON.stringify({ stamp: nextEventStamp(), reason }),
    });
  }

  async consumerCursor(consumerId: string): Promise<FoldSdkCursor | undefined> {
    const response = await this.request<{ readonly cursor?: FoldSdkCursor | null }>(
      `${this.workspacePath("consumers")}/${encodeURIComponent(consumerId)}`,
    );
    return response.cursor ?? undefined;
  }

  commitConsumerCursor(consumerId: string, cursor: FoldSdkCursor): Promise<unknown> {
    return this.request(`${this.workspacePath("consumers")}/${encodeURIComponent(consumerId)}`, {
      method: "POST",
      body: JSON.stringify({ cursor }),
    });
  }

  async *eventStream(options: EventStreamOptions = {}): AsyncGenerator<StreamedFoldEvent> {
    const params = new URLSearchParams();
    if (options.after !== undefined) {
      params.set("afterT", options.after.t.toString());
      params.set("afterEventId", options.after.eventId);
    }
    if (options.replay !== undefined) params.set("replay", options.replay);
    if (options.include !== undefined) params.set("include", options.include);
    appendRepeated(params, "kind", options.kinds);
    const response = await this.fetchImpl(
      `${this.baseUrl}${this.workspacePath("event-stream")}${params.size === 0 ? "" : `?${params}`}`,
      {
        headers: { authorization: `Bearer ${this.token}` },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { readonly error?: { readonly code?: string; readonly message?: string } };
      throw new SuperBrainApiError(response.status, body.error?.code ?? "stream_failed", body.error?.message ?? "Event stream failed");
    }
    if (response.body === null) throw new SuperBrainApiError(502, "stream_unavailable", "Event stream has no response body");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        buffer += value ?? "";
        let boundary: number;
        while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const frame = buffer.slice(0, boundary);
          const separator = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
          buffer = buffer.slice(boundary + separator.length);
          const lines = frame.split(/\r?\n/);
          const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
          if (eventName !== "fold-event") continue;
          const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data.length > 0) yield JSON.parse(data) as StreamedFoldEvent;
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  }

  async consumeEvents(options: ConsumeEventOptions): Promise<void> {
    let cursor = await this.consumerCursor(options.consumerId);
    const reconnect = options.reconnect ?? true;
    do {
      try {
        for await (const event of this.eventStream({
          ...(cursor === undefined ? { replay: options.replay ?? "tail" } : { after: cursor }),
          ...(options.include === undefined ? {} : { include: options.include }),
          ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })) {
          await options.onEvent(event);
          await this.commitConsumerCursor(options.consumerId, event.cursor);
          cursor = event.cursor;
        }
      } catch (error) {
        if (options.signal?.aborted === true) return;
        if (!reconnect || (error instanceof SuperBrainApiError && error.status < 500)) throw error;
      }
      if (!reconnect || options.signal?.aborted === true) return;
      await sleep(options.reconnectDelayMs ?? 1_000, options.signal);
    } while (true);
  }
}

export type { MemoryAudience };
