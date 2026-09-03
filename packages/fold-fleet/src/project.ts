import { compareEventKeys, type FoldEvent, type JsonValue } from "@_89/fold";
import {
  ACTIVITY_CLASSIFICATION_NODE_KIND,
  ACTIVITY_OBSERVATION_NODE_KIND,
  SENSOR_LIFECYCLE_NODE_KIND,
  validateActivityEventEnvelope,
} from "@_89/fold-activity";

import type {
  FleetAvailability,
  FleetProjectionOptions,
  FleetSessionIdentity,
  FleetSessionSnapshot,
  FleetSessionStatus,
  FleetSnapshot,
  OrphanRecoveryAction,
} from "./types.js";

export class FleetProjectionError extends Error {
  override readonly name = "FleetProjectionError";
}

interface MutableFleetSession extends FleetSessionIdentity {
  sensor: string;
  lastKnownStatus: FleetSessionStatus;
  lastSeenAt?: string;
  lastObservedAt?: string;
  heartbeatWindowMs?: number;
  lastLifecyclePhase?: "online" | "heartbeat" | "degraded" | "offline";
  lastDeclaredLifecyclePhase?: "online" | "degraded" | "offline";
}

const ACTIVE_STATUSES = new Set<FleetSessionStatus>([
  "pending",
  "starting",
  "authenticating",
  "ready",
  "busy",
  "blocked",
  "stopping",
]);

function requiredIdentity(event: FoldEvent): FleetSessionIdentity {
  const identity = event.capture.identity;
  const sessionId = identity?.session;
  const agentId = identity?.agent;
  const taskId = identity?.task;
  const repo = identity?.repo;
  const branch = identity?.branch;
  if (!sessionId || !agentId || !taskId || !repo || !branch) {
    throw new FleetProjectionError(
      `event ${event.id} is missing terminal identity: agent, task, repo, branch, session`,
    );
  }
  return {
    sessionId,
    agentId,
    taskId,
    repo,
    branch,
    ...(identity?.runtime === undefined ? {} : { runtime: identity.runtime }),
  };
}

function sameIdentity(left: FleetSessionIdentity, right: FleetSessionIdentity): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.agentId === right.agentId &&
    left.taskId === right.taskId &&
    left.repo === right.repo &&
    left.branch === right.branch &&
    left.runtime === right.runtime
  );
}

function sessionFor(
  sessions: Map<string, MutableFleetSession>,
  event: FoldEvent,
  sensor: string,
): MutableFleetSession {
  const identity = requiredIdentity(event);
  const existing = sessions.get(identity.sessionId);
  if (existing !== undefined) {
    if (!sameIdentity(existing, identity)) {
      throw new FleetProjectionError(`session ${identity.sessionId} changed immutable capture identity`);
    }
    if (existing.sensor !== sensor) {
      throw new FleetProjectionError(`session ${identity.sessionId} changed sensor identity`);
    }
    return existing;
  }
  const created: MutableFleetSession = {
    ...identity,
    sensor,
    lastKnownStatus: "pending",
  };
  sessions.set(identity.sessionId, created);
  return created;
}

function createPayload(event: FoldEvent, nodeKind: string): Record<string, JsonValue> | undefined {
  for (const change of event.changes) {
    if (change.verb === "create" && change.nodeKind === nodeKind) return change.after;
  }
  return undefined;
}

function stringField(payload: Record<string, JsonValue>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" ? value : undefined;
}

function dataField(payload: Record<string, JsonValue>): Record<string, JsonValue> | undefined {
  const value = payload.data;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function mapStatus(status: string): FleetSessionStatus | undefined {
  switch (status) {
    case "pending":
    case "starting":
    case "authenticating":
    case "ready":
    case "busy":
    case "stopping":
    case "stopped":
    case "error":
      return status;
    case "awaiting_auth":
      return "authenticating";
    case "awaiting_input":
    case "awaiting_approval":
      return "blocked";
    case "ready_for_input":
    case "completed":
      return "ready";
    case "busy_streaming":
      return "busy";
    case "unknown":
      return "unknown";
    default:
      return undefined;
  }
}

function processLifecycle(sessions: Map<string, MutableFleetSession>, event: FoldEvent): void {
  if (createPayload(event, SENSOR_LIFECYCLE_NODE_KIND) === undefined) return;
  const lifecycle = event.lifecycle;
  if (lifecycle === undefined) return;
  const session = sessionFor(sessions, event, lifecycle.sensor);
  session.lastSeenAt = lifecycle.observedAt;
  session.heartbeatWindowMs = lifecycle.heartbeatWindowMs;
  session.lastLifecyclePhase = lifecycle.phase;
  if (lifecycle.phase !== "heartbeat") session.lastDeclaredLifecyclePhase = lifecycle.phase;
  if (lifecycle.phase === "online") session.lastKnownStatus = "starting";
  else if (lifecycle.phase === "offline") session.lastKnownStatus = "stopped";
}

function processObservation(sessions: Map<string, MutableFleetSession>, event: FoldEvent): void {
  const payload = createPayload(event, ACTIVITY_OBSERVATION_NODE_KIND);
  if (payload === undefined) return;
  const sessionId = stringField(payload, "sessionId");
  const sensor = stringField(payload, "sensor");
  const observedAt = stringField(payload, "observedAt");
  const observation = stringField(payload, "observation");
  if (!sessionId || !sensor || !observedAt || !observation) {
    throw new FleetProjectionError(`event ${event.id} has an incomplete activity observation`);
  }
  const session = sessionFor(sessions, event, sensor);
  if (session.sessionId !== sessionId) {
    throw new FleetProjectionError(`event ${event.id} payload session does not match capture identity`);
  }
  session.lastObservedAt = observedAt;
  const data = dataField(payload);
  if (observation === "status_changed") {
    const status = data && stringField(data, "status");
    const mapped = status && mapStatus(status);
    if (mapped) session.lastKnownStatus = mapped;
  } else if (observation === "login_required" || observation === "auth_required") {
    session.lastKnownStatus = "authenticating";
  } else if (observation === "blocking_prompt") {
    session.lastKnownStatus = "blocked";
  } else if (
    observation === "prompt_submitted" ||
    observation === "stall_detected" ||
    observation === "tool_running" ||
    observation === "tool_result" ||
    observation === "file_changed" ||
    observation === "verification_result" ||
    observation === "reasoning_checkpoint" ||
    observation === "human_decision"
  ) {
    session.lastKnownStatus = "busy";
  } else if (observation === "task_complete") {
    session.lastKnownStatus = "ready";
  }
}

function processClassification(sessions: Map<string, MutableFleetSession>, event: FoldEvent): void {
  const payload = createPayload(event, ACTIVITY_CLASSIFICATION_NODE_KIND);
  if (payload === undefined) return;
  const sessionId = stringField(payload, "sessionId");
  const sensor = stringField(payload, "sensor");
  const observedAt = stringField(payload, "observedAt");
  const state = stringField(payload, "state");
  if (!sessionId || !sensor || !observedAt || !state) {
    throw new FleetProjectionError(`event ${event.id} has an incomplete activity classification`);
  }
  const session = sessionFor(sessions, event, sensor);
  if (session.sessionId !== sessionId) {
    throw new FleetProjectionError(`event ${event.id} payload session does not match capture identity`);
  }
  session.lastObservedAt = observedAt;
  const mapped = mapStatus(state);
  if (mapped) session.lastKnownStatus = mapped;
}

function availabilityOf(
  session: MutableFleetSession,
  freshness: FleetSessionSnapshot["freshness"],
): FleetAvailability {
  if (freshness !== "current") return "unknown";
  if (session.lastDeclaredLifecyclePhase === "offline") return "unavailable";
  if (session.lastDeclaredLifecyclePhase === "degraded") return "degraded";
  if (session.lastDeclaredLifecyclePhase === "online") return "available";
  return "unknown";
}

export function rebuildFleet(
  events: readonly FoldEvent[],
  nowMs: number,
  options: FleetProjectionOptions = {},
): FleetSnapshot {
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be finite");
  if (
    options.orphanAfterMs !== undefined &&
    (!Number.isFinite(options.orphanAfterMs) || options.orphanAfterMs <= 0)
  ) {
    throw new TypeError("orphanAfterMs must be finite and greater than zero");
  }
  const sessions = new Map<string, MutableFleetSession>();
  for (const event of [...events].sort(compareEventKeys)) {
    try {
      validateActivityEventEnvelope(event);
    } catch (error) {
      throw new FleetProjectionError(
        error instanceof Error ? error.message : `event ${event.id} has an invalid activity envelope`,
      );
    }
    processLifecycle(sessions, event);
    processObservation(sessions, event);
    processClassification(sessions, event);
  }

  const snapshots = new Map<string, FleetSessionSnapshot>();
  for (const session of [...sessions.values()].sort((left, right) =>
    left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0,
  )) {
    const lastSeenMs = session.lastSeenAt === undefined ? undefined : Date.parse(session.lastSeenAt);
    const freshness =
      lastSeenMs === undefined || session.heartbeatWindowMs === undefined
        ? "unknown"
        : nowMs - lastSeenMs > session.heartbeatWindowMs
          ? "stale"
          : "current";
    const orphanAfterMs = options.orphanAfterMs ?? session.heartbeatWindowMs;
    const orphaned =
      freshness === "stale" &&
      lastSeenMs !== undefined &&
      orphanAfterMs !== undefined &&
      nowMs - lastSeenMs > orphanAfterMs &&
      ACTIVE_STATUSES.has(session.lastKnownStatus);
    const status = freshness === "current" ? session.lastKnownStatus : "unknown";
    snapshots.set(session.sessionId, {
      sessionId: session.sessionId,
      agentId: session.agentId,
      taskId: session.taskId,
      repo: session.repo,
      branch: session.branch,
      ...(session.runtime === undefined ? {} : { runtime: session.runtime }),
      sensor: session.sensor,
      status,
      lastKnownStatus: session.lastKnownStatus,
      availability: availabilityOf(session, freshness),
      freshness,
      orphaned,
      ...(session.lastSeenAt === undefined ? {} : { lastSeenAt: session.lastSeenAt }),
      ...(session.lastObservedAt === undefined ? {} : { lastObservedAt: session.lastObservedAt }),
      ...(session.heartbeatWindowMs === undefined
        ? {}
        : { heartbeatWindowMs: session.heartbeatWindowMs }),
      ...(session.lastLifecyclePhase === undefined
        ? {}
        : { lastLifecyclePhase: session.lastLifecyclePhase }),
      ...(session.lastDeclaredLifecyclePhase === undefined
        ? {}
        : { lastDeclaredLifecyclePhase: session.lastDeclaredLifecyclePhase }),
    });
  }

  return { rebuiltAt: new Date(nowMs).toISOString(), sessions: snapshots };
}

export function listFleetSessions(snapshot: FleetSnapshot): FleetSessionSnapshot[] {
  return [...snapshot.sessions.values()];
}

export function planOrphanRecovery(snapshot: FleetSnapshot): OrphanRecoveryAction[] {
  return listFleetSessions(snapshot)
    .filter(
      (session): session is FleetSessionSnapshot & { lastSeenAt: string } =>
        session.orphaned && session.lastSeenAt !== undefined,
    )
    .map((session) => ({
      kind: "reconcile_orphan",
      sessionId: session.sessionId,
      sensor: session.sensor,
      detectedAt: snapshot.rebuiltAt,
      lastSeenAt: session.lastSeenAt,
      lastKnownStatus: session.lastKnownStatus,
      reason: `sensor stale since ${session.lastSeenAt}; last known session status ${session.lastKnownStatus}`,
    }));
}
