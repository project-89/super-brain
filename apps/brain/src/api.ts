import { nextEventStamp, uuidV7 } from "./ids";
import type {
  ConnectionSettings,
  FoldLogEntry,
  MemoryDraft,
  MemoryScope,
  PersonalMemory,
  ProjectionResponse,
  RecalledMemory,
} from "./types";

interface ApiErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly details?: unknown;
  };
}

export class FoldApiError extends Error {
  override readonly name = "FoldApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function appendRepeated(params: URLSearchParams, key: string, values?: readonly string[]): void {
  values?.forEach((value) => {
    if (value.trim()) params.append(key, value.trim());
  });
}

export class FoldApiClient {
  constructor(private readonly settings: ConnectionSettings) {}

  private workspacePath(resource: string): string {
    return `/v1/workspaces/${encodeURIComponent(this.settings.workspaceId)}/${resource}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.settings.token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    let response: Response;
    try {
      response = await fetch(`${this.settings.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      throw new FoldApiError(0, "network_error", error instanceof Error ? error.message : "API request failed");
    }
    const body = (await response.json().catch(() => ({}))) as ApiErrorBody;
    if (!response.ok) {
      throw new FoldApiError(
        response.status,
        body.error?.code ?? "request_failed",
        body.error?.message ?? `API request failed (${response.status})`,
        body.error?.details,
      );
    }
    return body as T;
  }

  async listEvents(options: { readonly includeDrafts?: boolean; readonly kinds?: readonly string[] } = {}) {
    const params = new URLSearchParams();
    if (options.includeDrafts) params.set("include", "canon+draft");
    appendRepeated(params, "kind", options.kinds);
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const response = await this.request<{ readonly entries: readonly FoldLogEntry[] }>(
      `${this.workspacePath("events")}${query}`,
    );
    return response.entries;
  }

  async projection(includeDrafts = false): Promise<ProjectionResponse> {
    const query = includeDrafts ? "?include=canon%2Bdraft" : "";
    return this.request<ProjectionResponse>(`${this.workspacePath("projection")}${query}`);
  }

  async recallMemories(options: {
    readonly scope?: MemoryScope;
    readonly tags?: readonly string[];
    readonly sources?: readonly string[];
    readonly from?: number;
    readonly to?: number;
    readonly limit?: number;
  } = {}): Promise<readonly RecalledMemory[]> {
    const params = new URLSearchParams();
    if (options.scope !== undefined) {
      params.set("scope", options.scope.kind);
      if (options.scope.kind === "space") params.set("spaceId", options.scope.spaceId);
    }
    appendRepeated(params, "tag", options.tags);
    appendRepeated(params, "source", options.sources);
    if (options.from !== undefined) params.set("from", options.from.toString());
    if (options.to !== undefined) params.set("to", options.to.toString());
    if (options.limit !== undefined) params.set("limit", options.limit.toString());
    const query = params.size > 0 ? `?${params.toString()}` : "";
    const response = await this.request<{ readonly memories: readonly RecalledMemory[] }>(
      `${this.workspacePath("memories")}${query}`,
    );
    return response.memories;
  }

  async createMemory(draft: MemoryDraft): Promise<PersonalMemory> {
    const stamp = nextEventStamp();
    const response = await this.request<{ readonly memory: PersonalMemory }>(
      this.workspacePath("memories"),
      {
        method: "POST",
        body: JSON.stringify({
          stamp,
          input: {
            id: uuidV7(stamp.t),
            source: draft.source,
            summary: draft.summary,
            content: draft.content,
            tags: draft.tags,
            ...(draft.spaceId === undefined ? {} : { spaceId: draft.spaceId }),
          },
        }),
      },
    );
    return response.memory;
  }

  async reviseMemory(memoryId: string, draft: MemoryDraft): Promise<PersonalMemory> {
    const response = await this.request<{ readonly memory: PersonalMemory }>(
      `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          stamp: nextEventStamp(),
          patch: { summary: draft.summary, content: draft.content, tags: draft.tags },
        }),
      },
    );
    return response.memory;
  }

  async forgetMemory(memoryId: string, reason: string): Promise<void> {
    await this.request(
      `${this.workspacePath("memories")}/${encodeURIComponent(memoryId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ stamp: nextEventStamp(), reason }),
      },
    );
  }
}
