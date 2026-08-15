import type { FoldEvent, FoldState } from "@_89/fold";

export type EntityId = string;

export interface NarrativeArc {
  readonly id: EntityId;
  readonly kind?: string;
  readonly owner?: EntityId;
  readonly question?: string;
  readonly stakesBaseline?: number;
}

export interface NarrativeDefinition {
  readonly arcs: readonly NarrativeArc[];
  readonly convergenceThreshold?: number;
}

export interface ArcRuntime {
  state: "open" | "closed";
  resolvedBy: EntityId | null;
  tension: number;
  stakes: number;
  openedAt: number | null;
}

export interface KnowledgeCell {
  readonly known: Set<EntityId>;
  readonly shielded: Set<EntityId>;
}

export interface ResolvedPeak {
  readonly arc: EntityId;
  readonly tension: number;
  readonly stakes: number;
}

export interface NarrativeState {
  readonly foldState: FoldState;
  readonly arcs: Map<EntityId, ArcRuntime>;
  readonly knowledge: Map<EntityId, KnowledgeCell>;
  readonly memberships: Map<EntityId, Set<EntityId>>;
  readonly resolvedPeaks: Map<EntityId, ResolvedPeak[]>;
  readonly applied: FoldEvent[];
}

export interface CurvePoint {
  readonly t: number;
  readonly worldDate: string;
  readonly event: EntityId;
  readonly value: number;
}
