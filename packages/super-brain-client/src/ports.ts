import type { FoldLogEntry, FoldState, JsonValue } from "@_89/fold";
import type { FleetReadModel, SteeringSnapshot, TrajectoryTaskReport } from "@_89/fold-sdk";
export type ProjectionSection = "nodes" | "edges" | "values" | "redirects" | "diagnostics";
export interface SerializedFoldState {
 readonly values: readonly [string, JsonValue][];
 readonly nodes: readonly [string, FoldState["nodes"] extends ReadonlyMap<string, infer T> ? T : never][];
 readonly edges: readonly [string, FoldState["edges"] extends ReadonlyMap<string, infer T> ? T : never][];
 readonly redirects: readonly [string, string][];
 readonly diagnostics: FoldState["diagnostics"];
 readonly appliedEvents: FoldState["appliedEvents"];
 readonly appliedChanges: FoldState["appliedChanges"];
 readonly appliedEventCount?: number; readonly appliedChangeCount?: number;
}
export interface ProjectionResponse { readonly entries: readonly FoldLogEntry[]; readonly state: SerializedFoldState; readonly total?: number; readonly projected?: number; readonly section?: ProjectionSection; readonly sectionTotal?: number; readonly nextCursor?: string; readonly counts?: Readonly<Record<ProjectionSection, number>> }
export interface FleetResponse { readonly fleet: FleetReadModel }
export interface SteeringResponse { readonly actors: readonly SteeringSnapshot[]; readonly steeringEnabled: boolean }
export type SerializedTrajectoryTaskReport = Omit<TrajectoryTaskReport, "analysis"> & { readonly analysis: Omit<TrajectoryTaskReport["analysis"], "edgeOutcomes"> & { readonly edgeOutcomes: readonly (TrajectoryTaskReport["analysis"]["edgeOutcomes"] extends ReadonlyMap<unknown, infer T> ? T : never)[] }; readonly runTotal: number; readonly runCursor?: string };
export type SteeringCommand =
  | { readonly action: "surface"; readonly candidate: Omit<SteeringSnapshot["pendingCandidates"][number], "surfacedAtMs"> }
  | { readonly action: "commit"; readonly candidateId: string; readonly intentionId: string }
  | { readonly action: "decline"; readonly candidateId: string; readonly reason: string }
  | { readonly action: "acted"; readonly intentionId: string }
  | { readonly action: "end"; readonly intentionId: string; readonly end: { readonly kind: "satisfied" } | { readonly kind: "abandoned"; readonly reason: string } | { readonly kind: "expired" } | { readonly kind: "superseded"; readonly byIntentionId: string } };
export interface EventPageOptions { readonly eventIds?: readonly string[]; readonly includeDrafts?: boolean; readonly include?: "canon" | "canon+draft"; readonly kinds?: readonly string[]; readonly limit?: number; readonly cursor?: string; readonly order?: "asc" | "desc"; readonly sessionId?: string; readonly runId?: string; readonly projectId?: string; readonly actorId?: string }
