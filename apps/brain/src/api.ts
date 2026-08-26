import { nextEventStamp, uuidV7 } from "./ids";
import type {
  ConnectionSettings,
  FoldLogEntry,
  FleetResponse,
  MemoryDraft,
  MemoryScope,
  PersonalMemory,
  ProjectionResponse,
  RecalledMemory,
  RankedMemoryRecallResult,
  ReasoningResponse,
  SharedDecisionTree,
  SteeringCandidateDraft,
  SteeringIntentionEnd,
  SteeringResponse,
  TrajectoryImportBundle,
  TrajectoryInput,
  TrajectoryTaskReport,
  TrajectoryTaskSummary,
  TranscriptProjectSummary,
  TranscriptRun,
  TranscriptRunDetail,
  TranscriptSource,
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

  async listTrajectoryTasks(): Promise<readonly TrajectoryTaskSummary[]> {
    const response = await this.request<{ readonly tasks: readonly TrajectoryTaskSummary[] }>(
      this.workspacePath("trajectory-tasks"),
    );
    return response.tasks;
  }

  async trajectoryReport(taskId: string): Promise<TrajectoryTaskReport> {
    const response = await this.request<{ readonly report: TrajectoryTaskReport }>(
      `${this.workspacePath("trajectory-tasks")}/${encodeURIComponent(taskId)}`,
    );
    return response.report;
  }

  async fleet(): Promise<FleetResponse> {
    return this.request<FleetResponse>(this.workspacePath("fleet"));
  }

  async listTranscriptProjects(): Promise<readonly TranscriptProjectSummary[]> {
    const response = await this.request<{ readonly projects: readonly TranscriptProjectSummary[] }>(
      this.workspacePath("transcript-projects"),
    );
    return response.projects;
  }

  async listTranscriptRuns(options: {
    readonly projectId?: string;
    readonly source?: TranscriptSource;
  } = {}): Promise<readonly TranscriptRun[]> {
    const params = new URLSearchParams();
    if (options.projectId !== undefined) params.set("projectId", options.projectId);
    if (options.source !== undefined) params.set("source", options.source);
    const query = params.size === 0 ? "" : `?${params.toString()}`;
    const response = await this.request<{ readonly runs: readonly TranscriptRun[] }>(
      `${this.workspacePath("transcript-runs")}${query}`,
    );
    return response.runs;
  }

  async transcriptRun(runId: string): Promise<TranscriptRunDetail> {
    return this.request<TranscriptRunDetail>(
      `${this.workspacePath("transcript-runs")}/${encodeURIComponent(runId)}`,
    );
  }

  async steering(): Promise<SteeringResponse> {
    return this.request<SteeringResponse>(this.workspacePath("steering"));
  }

  private async steer(actorId: string, body: Readonly<Record<string, unknown>>): Promise<void> {
    await this.request(`${this.workspacePath("steering")}/${encodeURIComponent(actorId)}`, {
      method: "POST",
      body: JSON.stringify({ ...body, stamp: nextEventStamp() }),
    });
  }

  async surfaceSteeringCandidate(draft: SteeringCandidateDraft): Promise<void> {
    const now = Date.now();
    await this.steer(draft.actorId, {
      action: "surface",
      candidate: {
        id: `candidate-${uuidV7(now)}`,
        sourceDriveId: draft.sourceDriveId,
        satisfier: { kind: draft.satisfierKind, ref: draft.satisfierRef },
        aim: draft.aim,
        trigger: draft.trigger,
      },
    });
  }

  async commitSteeringCandidate(actorId: string, candidateId: string): Promise<void> {
    await this.steer(actorId, {
      action: "commit",
      candidateId,
      intentionId: `intention-${uuidV7()}`,
    });
  }

  async declineSteeringCandidate(actorId: string, candidateId: string, reason: string): Promise<void> {
    await this.steer(actorId, { action: "decline", candidateId, reason });
  }

  async recordSteeringAction(actorId: string, intentionId: string): Promise<void> {
    await this.steer(actorId, { action: "acted", intentionId });
  }

  async endSteeringIntention(
    actorId: string,
    intentionId: string,
    end: SteeringIntentionEnd,
  ): Promise<void> {
    await this.steer(actorId, { action: "end", intentionId, end });
  }

  async askReasoning(question: string, actorId?: string): Promise<ReasoningResponse> {
    return this.request<ReasoningResponse>(this.workspacePath("reasoning/ask"), {
      method: "POST",
      body: JSON.stringify({ question, ...(actorId === undefined ? {} : { actorId }), limit: 5 }),
    });
  }

  async recordTrajectoryTree(tree: SharedDecisionTree, spaceId?: string): Promise<void> {
    await this.request(this.workspacePath("trajectory-tasks"), {
      method: "POST",
      body: JSON.stringify({
        stamp: nextEventStamp(),
        ...(spaceId === undefined ? {} : { spaceId }),
        tree,
      }),
    });
  }

  async recordTrajectory(input: TrajectoryInput, spaceId?: string): Promise<void> {
    await this.request(this.workspacePath("trajectories"), {
      method: "POST",
      body: JSON.stringify({
        stamp: nextEventStamp(),
        ...(spaceId === undefined ? {} : { spaceId }),
        input,
      }),
    });
  }

  async importTrajectoryBundle(
    bundle: TrajectoryImportBundle,
    existingTasks: readonly TrajectoryTaskSummary[],
  ): Promise<number> {
    const existing = existingTasks.find(({ taskId }) => taskId === bundle.tree.taskId);
    if (existing !== undefined && JSON.stringify(existing.tree) !== JSON.stringify(bundle.tree)) {
      throw new FoldApiError(409, "trajectory_tree_mismatch", `Task ${bundle.tree.taskId} already has a different shared tree`);
    }
    if (existing === undefined) {
      await this.recordTrajectoryTree(bundle.tree, bundle.spaceId);
    }
    for (const trajectory of bundle.trajectories) {
      await this.recordTrajectory(trajectory, bundle.spaceId);
    }
    return bundle.trajectories.length;
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

  async rankMemories(options: {
    readonly query: string;
    readonly scope?: MemoryScope;
    readonly sources?: readonly string[];
    readonly limit?: number;
  }): Promise<RankedMemoryRecallResult> {
    return this.request<RankedMemoryRecallResult>(this.workspacePath("memories/search"), {
      method: "POST",
      body: JSON.stringify(options),
    });
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
