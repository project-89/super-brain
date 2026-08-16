export type FleetSessionStatus =
  | "pending"
  | "starting"
  | "authenticating"
  | "ready"
  | "busy"
  | "blocked"
  | "stopping"
  | "stopped"
  | "error"
  | "unknown";

export type FleetAvailability = "available" | "degraded" | "unavailable" | "unknown";

export interface FleetSessionIdentity {
  readonly sessionId: string;
  readonly agentId: string;
  readonly taskId: string;
  readonly repo: string;
  readonly branch: string;
  readonly runtime?: string;
}

export interface FleetSessionSnapshot extends FleetSessionIdentity {
  readonly sensor: string;
  readonly status: FleetSessionStatus;
  readonly lastKnownStatus: FleetSessionStatus;
  readonly availability: FleetAvailability;
  readonly freshness: "current" | "stale" | "unknown";
  readonly orphaned: boolean;
  readonly lastSeenAt?: string;
  readonly lastObservedAt?: string;
  readonly heartbeatWindowMs?: number;
  readonly lastLifecyclePhase?: "online" | "heartbeat" | "degraded" | "offline";
  readonly lastDeclaredLifecyclePhase?: "online" | "degraded" | "offline";
}

export interface FleetSnapshot {
  readonly rebuiltAt: string;
  readonly sessions: ReadonlyMap<string, FleetSessionSnapshot>;
}

export interface FleetProjectionOptions {
  /** Silence beyond this threshold makes an active session an orphan candidate. */
  readonly orphanAfterMs?: number;
}

export interface OrphanRecoveryAction {
  readonly kind: "reconcile_orphan";
  readonly sessionId: string;
  readonly sensor: string;
  readonly detectedAt: string;
  readonly lastSeenAt: string;
  readonly lastKnownStatus: FleetSessionStatus;
  readonly reason: string;
}
