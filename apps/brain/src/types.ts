export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ConnectionSettings {
  readonly baseUrl: string;
  readonly workspaceId: string;
  readonly token: string;
}

export interface EventAuthor {
  readonly kind: "human" | "simulation" | "agent" | "rule" | "generator" | "ingest" | "sensor";
  readonly id: string;
  readonly productionId?: string;
}

export interface FoldChange {
  readonly verb: string;
  readonly subject: string;
  readonly component?: string;
  readonly field?: string;
  readonly object?: string;
  readonly before?: JsonValue;
  readonly after?: JsonValue;
  readonly amount?: number;
  readonly nodeKind?: string;
  readonly edgeType?: string;
  readonly edgeId?: string;
  readonly [key: string]: JsonValue | undefined;
}

export interface FoldEvent {
  readonly specVersion: "0.7";
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly description?: string;
  readonly at: {
    readonly t: number;
    readonly worldDate: string;
    readonly granularity?: string;
  };
  readonly timelineId?: string;
  readonly participants?: readonly string[];
  readonly location?: string;
  readonly author: EventAuthor;
  readonly causedBy?: readonly string[];
  readonly capture: {
    readonly scope: {
      readonly workspace: string;
      readonly space?: string;
      readonly creator?: string;
    };
    readonly identity?: Readonly<Record<string, string>>;
  };
  readonly changes: readonly FoldChange[];
  readonly [key: string]: unknown;
}

export interface FoldLogEntry {
  readonly event: FoldEvent;
  readonly status: "canon" | "draft";
}

export interface PersonalMemory {
  readonly id: string;
  readonly workspaceId: string;
  readonly spaceId?: string;
  readonly creatorId: string;
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly entities: readonly {
    readonly id: string;
    readonly type: string;
    readonly name: string;
  }[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly revision: number;
}

export interface RecalledMemory {
  readonly memory: PersonalMemory;
  readonly score?: number;
}

export interface SerializedFoldState {
  readonly values: readonly [string, JsonValue][];
  readonly nodes: readonly [string, { readonly kind: string; readonly data: Readonly<Record<string, JsonValue>> }][];
  readonly edges: readonly [string, Readonly<Record<string, JsonValue>>][];
  readonly redirects: readonly [string, string][];
  readonly diagnostics: readonly Readonly<Record<string, JsonValue>>[];
  readonly appliedEvents: readonly FoldEvent[];
  readonly appliedChanges: readonly Readonly<Record<string, JsonValue>>[];
}

export interface ProjectionResponse {
  readonly entries: readonly FoldLogEntry[];
  readonly state: SerializedFoldState;
}

export interface BrainSnapshot {
  readonly events: readonly FoldLogEntry[];
  readonly memories: readonly RecalledMemory[];
  readonly projection: ProjectionResponse;
  readonly loadedAt: number;
}

export type MemoryScope =
  | { readonly kind: "all" }
  | { readonly kind: "workspace" }
  | { readonly kind: "space"; readonly spaceId: string };

export interface MemoryDraft {
  readonly source: string;
  readonly summary: string;
  readonly content: JsonValue;
  readonly tags: readonly string[];
  readonly spaceId?: string;
}
