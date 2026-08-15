import { compareEventKeys } from "./order.js";
import type { FoldEvent, Lifecycle } from "./schema.js";

export type SensorStatus = "online" | "degraded" | "offline" | "unknown";

export interface SensorStatusSnapshot {
  readonly sensor: string;
  readonly status: SensorStatus;
  readonly freshness: "current" | "stale" | "unknown";
  readonly lastSeenAt?: string;
  readonly lastDeclaredStatus?: Exclude<SensorStatus, "unknown">;
  readonly heartbeatWindowMs?: number;
}

function lifecycleEvents(events: readonly FoldEvent[], sensor: string): Lifecycle[] {
  return [...events]
    .sort(compareEventKeys)
    .flatMap((event) =>
      event.lifecycle?.sensor === sensor ? [event.lifecycle] : [],
    );
}

export function sensorStatusAt(
  events: readonly FoldEvent[],
  sensor: string,
  nowMs: number,
): SensorStatusSnapshot {
  const records = lifecycleEvents(events, sensor);
  if (records.length === 0) {
    return { sensor, status: "unknown", freshness: "unknown" };
  }

  let declaredStatus: Exclude<SensorStatus, "unknown"> | undefined;
  for (const record of records) {
    if (record.phase !== "heartbeat") declaredStatus = record.phase;
  }

  const latest = records.at(-1)!;
  const lastSeenMs = Date.parse(latest.observedAt);
  const stale = nowMs - lastSeenMs > latest.heartbeatWindowMs;

  if (stale) {
    return {
      sensor,
      status: "unknown",
      freshness: "stale",
      lastSeenAt: latest.observedAt,
      ...(declaredStatus === undefined ? {} : { lastDeclaredStatus: declaredStatus }),
      heartbeatWindowMs: latest.heartbeatWindowMs,
    };
  }

  return {
    sensor,
    status: declaredStatus ?? "unknown",
    freshness: "current",
    lastSeenAt: latest.observedAt,
    ...(declaredStatus === undefined ? {} : { lastDeclaredStatus: declaredStatus }),
    heartbeatWindowMs: latest.heartbeatWindowMs,
  };
}

