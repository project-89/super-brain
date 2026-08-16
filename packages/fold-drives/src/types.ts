import type { Author, CaptureEnvelope, JsonValue } from "@_89/fold";

export type DriveEntry =
  | {
      readonly kind: "event";
      readonly type: string;
      readonly payload?: Readonly<Record<string, JsonValue>>;
    }
  | {
      readonly kind: "action";
      readonly type: string;
      readonly payload?: Readonly<Record<string, JsonValue>>;
    };

export type DriveEntryMatcher =
  | {
      readonly kind: "event";
      readonly type: string;
      readonly predicate?: (entry: Extract<DriveEntry, { kind: "event" }>) => boolean;
    }
  | {
      readonly kind: "action";
      readonly type: string;
      readonly predicate?: (entry: Extract<DriveEntry, { kind: "action" }>) => boolean;
    };

export interface SatiationBinding {
  readonly matches: DriveEntryMatcher;
  readonly amount: number;
}

export type DriftFunction =
  | { readonly kind: "linear"; readonly ratePerHour: number }
  | { readonly kind: "exponential"; readonly halfLifeHours: number }
  | {
      readonly kind: "custom";
      readonly id: string;
      readonly compute: (current: number, dtMs: number) => number;
    };

export interface Satisfier {
  readonly kind: string;
  readonly ref: string;
  readonly params?: Readonly<Record<string, JsonValue>>;
}

export interface Pursuable {
  readonly satisfier: Satisfier;
  readonly threshold?: number;
  readonly hint?: string;
}

export interface DriveConfig {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tier: number;
  readonly weight: number;
  readonly initialLevel: number;
  readonly target: number;
  readonly drift: DriftFunction;
  readonly satiatedBy: readonly SatiationBinding[];
  readonly pursuableBy?: readonly Pursuable[];
}

export interface DriveState extends Omit<DriveConfig, "initialLevel"> {
  readonly level: number;
}

export interface WearConfig {
  readonly criticalThreshold: number;
  readonly recoveryThreshold: number;
  readonly tier1SaturationMs: number;
  readonly recoveryHorizonMs: number;
}

export type WearZone = "below" | "between" | "above";

export interface ChronicTracker {
  readonly sustainedBelowMs: number;
  readonly sustainedAboveMs: number;
}

export interface WearState {
  readonly perDrive: ReadonlyMap<string, ChronicTracker>;
  readonly chronicLoad: number;
}

export interface DriveSystemConfig {
  readonly actorId: string;
  readonly tierCount: number;
  readonly drives: readonly DriveConfig[];
  readonly wear?: Partial<WearConfig>;
}

export interface DriveSystemState {
  readonly actorId: string;
  readonly tierCount: number;
  readonly elapsedMs: number;
  readonly drives: ReadonlyMap<string, DriveState>;
  readonly wear: WearState;
  readonly wearConfig: WearConfig;
}

export interface DriveSatiation {
  readonly atMs: number;
  readonly driveId: string;
  readonly before: number;
  readonly after: number;
  readonly requested: number;
  readonly entry: DriveEntry;
  readonly causeEventId?: string;
}

export interface WearTransition {
  readonly atMs: number;
  readonly driveId: string;
  readonly from: WearZone;
  readonly to: WearZone;
  readonly level: number;
  readonly causeEventId?: string;
}

export interface DriveAdvanceResult {
  readonly state: DriveSystemState;
  readonly wearTransitions: readonly WearTransition[];
}

export interface DriveIntegrationResult {
  readonly state: DriveSystemState;
  readonly satiations: readonly DriveSatiation[];
  readonly wearTransitions: readonly WearTransition[];
}

export interface DriveSummary {
  readonly id: string;
  readonly name: string;
  readonly tier: number;
  readonly level: number;
  readonly target: number;
  readonly pressure: number;
  readonly chronic: boolean;
}

export interface DriveSystemSnapshot {
  readonly actorId: string;
  readonly elapsedMs: number;
  readonly levels: Readonly<Record<string, number>>;
  readonly wear: {
    readonly perDrive: Readonly<Record<string, ChronicTracker>>;
    readonly chronicLoad: number;
  };
}

export type SurfacingTrigger =
  | { readonly kind: "coincidence"; readonly note: string }
  | { readonly kind: "quiet" }
  | { readonly kind: "threshold" };

export interface SurfacedCandidate {
  readonly id: string;
  readonly sourceDriveId: string;
  readonly satisfier: Satisfier;
  readonly aim: string;
  readonly surfacedAtMs: number;
  readonly trigger: SurfacingTrigger;
}

export interface Intention {
  readonly id: string;
  readonly aim: string;
  readonly sourceDriveId: string;
  readonly satisfier: Satisfier;
  readonly fromCandidateId: string;
  readonly formedAtMs: number;
  readonly attempts: number;
}

export type IntentionEnd =
  | { readonly kind: "satisfied" }
  | { readonly kind: "abandoned"; readonly reason: string }
  | { readonly kind: "superseded"; readonly byIntentionId: string }
  | { readonly kind: "expired" };

export interface IntentionDecline {
  readonly candidate: SurfacedCandidate;
  readonly reason: string;
  readonly atMs: number;
}

export interface IntentionProjection {
  readonly actorId: string;
  readonly candidates: ReadonlyMap<string, SurfacedCandidate>;
  readonly pendingCandidates: readonly SurfacedCandidate[];
  readonly intentions: ReadonlyMap<string, Intention>;
  readonly declines: readonly IntentionDecline[];
}

export interface SurfacingEligibility {
  readonly driveId: string;
  readonly satisfier: Satisfier;
  readonly hint?: string;
  readonly pressure: number;
  readonly threshold: number;
}

export interface DriveCaptureIdentity extends Readonly<Record<string, string>> {
  readonly actor: string;
}

export type DriveCaptureEnvelope = Omit<CaptureEnvelope, "identity"> & {
  readonly identity: DriveCaptureIdentity;
};

export interface DriveEventContext {
  readonly actorId: string;
  readonly author: Author;
  readonly capture: DriveCaptureEnvelope;
}

export interface DriveEventStamp {
  readonly id: string;
  readonly t: number;
  readonly worldDate: string;
}
