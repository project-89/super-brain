import type {
  ChronicTracker,
  DriveAdvanceResult,
  DriveConfig,
  DriveEntry,
  DriveIntegrationResult,
  DriveState,
  DriveSummary,
  DriveSystemConfig,
  DriveSystemSnapshot,
  DriveSystemState,
  DriftFunction,
  WearConfig,
  WearState,
  WearTransition,
  WearZone,
} from "./types.js";

const MS_PER_HOUR = 3_600_000;

export const DEFAULT_WEAR_CONFIG: WearConfig = {
  criticalThreshold: 0.2,
  recoveryThreshold: 0.4,
  tier1SaturationMs: 24 * MS_PER_HOUR,
  recoveryHorizonMs: 12 * MS_PER_HOUR,
};

export class DriveConfigError extends Error {
  override readonly name = "DriveConfigError";
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) throw new DriveConfigError(`${label} must not be empty`);
}

function requireFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new DriveConfigError(`${label} must be finite`);
}

function requireUnit(value: number, label: string): void {
  requireFinite(value, label);
  if (value < 0 || value > 1) throw new DriveConfigError(`${label} must be within [0, 1]`);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateWearConfig(config: WearConfig): void {
  requireUnit(config.criticalThreshold, "wear criticalThreshold");
  requireUnit(config.recoveryThreshold, "wear recoveryThreshold");
  if (config.criticalThreshold >= config.recoveryThreshold) {
    throw new DriveConfigError("wear criticalThreshold must be less than recoveryThreshold");
  }
  requireFinite(config.tier1SaturationMs, "wear tier1SaturationMs");
  requireFinite(config.recoveryHorizonMs, "wear recoveryHorizonMs");
  if (config.tier1SaturationMs <= 0 || config.recoveryHorizonMs <= 0) {
    throw new DriveConfigError("wear time horizons must be greater than zero");
  }
}

function validateDrift(drift: DriftFunction, driveId: string): void {
  if (drift.kind === "linear") {
    requireFinite(drift.ratePerHour, `drive ${driveId} linear ratePerHour`);
  } else if (drift.kind === "exponential") {
    requireFinite(drift.halfLifeHours, `drive ${driveId} exponential halfLifeHours`);
    if (drift.halfLifeHours <= 0) {
      throw new DriveConfigError(`drive ${driveId} exponential halfLifeHours must be greater than zero`);
    }
  } else {
    requireNonEmpty(drift.id, `drive ${driveId} custom drift id`);
  }
}

function validateDrive(config: DriveConfig, tierCount: number): void {
  requireNonEmpty(config.id, "drive id");
  requireNonEmpty(config.name, `drive ${config.id} name`);
  if (!Number.isInteger(config.tier) || config.tier < 1 || config.tier > tierCount) {
    throw new DriveConfigError(`drive ${config.id} tier must be an integer within [1, ${tierCount}]`);
  }
  requireUnit(config.weight, `drive ${config.id} weight`);
  requireUnit(config.initialLevel, `drive ${config.id} initialLevel`);
  requireUnit(config.target, `drive ${config.id} target`);
  validateDrift(config.drift, config.id);
  for (const binding of config.satiatedBy) {
    requireNonEmpty(binding.matches.type, `drive ${config.id} satiation matcher type`);
    requireUnit(binding.amount, `drive ${config.id} satiation amount`);
  }
  for (const pursuable of config.pursuableBy ?? []) {
    requireNonEmpty(pursuable.satisfier.kind, `drive ${config.id} satisfier kind`);
    requireNonEmpty(pursuable.satisfier.ref, `drive ${config.id} satisfier ref`);
    if (pursuable.threshold !== undefined) {
      requireFinite(pursuable.threshold, `drive ${config.id} surfacing threshold`);
      if (pursuable.threshold < 0) {
        throw new DriveConfigError(`drive ${config.id} surfacing threshold must not be negative`);
      }
    }
  }
}

export function createDriveSystem(config: DriveSystemConfig): DriveSystemState {
  requireNonEmpty(config.actorId, "actorId");
  if (!Number.isInteger(config.tierCount) || config.tierCount < 1) {
    throw new DriveConfigError("tierCount must be a positive integer");
  }
  const wearConfig = { ...DEFAULT_WEAR_CONFIG, ...config.wear };
  validateWearConfig(wearConfig);
  const drives = new Map<string, DriveState>();
  for (const drive of config.drives) {
    validateDrive(drive, config.tierCount);
    if (drives.has(drive.id)) throw new DriveConfigError(`duplicate drive id: ${drive.id}`);
    const { initialLevel, ...definition } = drive;
    drives.set(drive.id, { ...definition, level: initialLevel });
  }
  return {
    actorId: config.actorId,
    tierCount: config.tierCount,
    elapsedMs: 0,
    drives,
    wear: { perDrive: new Map(), chronicLoad: 0 },
    wearConfig,
  };
}

export function applyDrift(drift: DriftFunction, current: number, dtMs: number): number {
  if (dtMs <= 0) return current;
  let next: number;
  if (drift.kind === "linear") {
    next = current + drift.ratePerHour * (dtMs / MS_PER_HOUR);
  } else if (drift.kind === "exponential") {
    next = current * 0.5 ** (dtMs / MS_PER_HOUR / drift.halfLifeHours);
  } else {
    next = drift.compute(current, dtMs);
  }
  if (!Number.isFinite(next)) throw new TypeError("drift computation must return a finite number");
  return clamp01(next);
}

export function drivePressure(drive: DriveState): number {
  return Math.max(0, drive.target - drive.level);
}

export function weightedPressure(drive: DriveState): number {
  return drivePressure(drive) * drive.weight;
}

export function wearZone(level: number, config: WearConfig): WearZone {
  if (level < config.criticalThreshold) return "below";
  if (level > config.recoveryThreshold) return "above";
  return "between";
}

function tickTracker(
  tracker: ChronicTracker,
  level: number,
  dtMs: number,
  config: WearConfig,
): ChronicTracker {
  if (level < config.criticalThreshold) {
    return { sustainedBelowMs: tracker.sustainedBelowMs + dtMs, sustainedAboveMs: 0 };
  }
  if (level > config.recoveryThreshold) {
    const sustainedAboveMs = tracker.sustainedAboveMs + dtMs;
    if (sustainedAboveMs >= config.recoveryHorizonMs) {
      return { sustainedBelowMs: 0, sustainedAboveMs: config.recoveryHorizonMs };
    }
    return { sustainedBelowMs: tracker.sustainedBelowMs, sustainedAboveMs };
  }
  return tracker;
}

function chronicLoad(
  trackers: ReadonlyMap<string, ChronicTracker>,
  drives: ReadonlyMap<string, DriveState>,
  config: WearConfig,
): number {
  let contribution = 0;
  let weight = 0;
  for (const drive of drives.values()) {
    const tracker = trackers.get(drive.id);
    if (tracker === undefined) continue;
    const saturationMs = config.tier1SaturationMs * (1 + (drive.tier - 1) * 0.5);
    const raw = Math.min(1, tracker.sustainedBelowMs / saturationMs);
    const recovery = Math.min(1, tracker.sustainedAboveMs / config.recoveryHorizonMs);
    const tierWeight = 1 / drive.tier;
    contribution += raw * (1 - recovery) * tierWeight;
    weight += tierWeight;
  }
  return weight === 0 ? 0 : clamp01(contribution / weight);
}

function transitionsBetween(
  before: ReadonlyMap<string, DriveState>,
  after: ReadonlyMap<string, DriveState>,
  atMs: number,
  config: WearConfig,
  causeEventId?: string,
): WearTransition[] {
  const transitions: WearTransition[] = [];
  for (const [id, drive] of after) {
    const previous = before.get(id);
    if (previous === undefined) continue;
    const from = wearZone(previous.level, config);
    const to = wearZone(drive.level, config);
    if (from !== to) {
      transitions.push({
        atMs,
        driveId: id,
        from,
        to,
        level: drive.level,
        ...(causeEventId === undefined ? {} : { causeEventId }),
      });
    }
  }
  return transitions;
}

export function advanceDriveSystem(state: DriveSystemState, dtMs: number): DriveAdvanceResult {
  if (!Number.isFinite(dtMs)) throw new TypeError("dtMs must be finite");
  if (dtMs <= 0) return { state, wearTransitions: [] };
  const drives = new Map<string, DriveState>();
  for (const [id, drive] of state.drives) {
    drives.set(id, { ...drive, level: applyDrift(drive.drift, drive.level, dtMs) });
  }
  const atMs = state.elapsedMs + dtMs;
  const trackers = new Map<string, ChronicTracker>();
  for (const [id, drive] of drives) {
    const tracker = state.wear.perDrive.get(id) ?? { sustainedBelowMs: 0, sustainedAboveMs: 0 };
    trackers.set(id, tickTracker(tracker, drive.level, dtMs, state.wearConfig));
  }
  const wear: WearState = {
    perDrive: trackers,
    chronicLoad: chronicLoad(trackers, drives, state.wearConfig),
  };
  return {
    state: { ...state, elapsedMs: atMs, drives, wear },
    wearTransitions: transitionsBetween(state.drives, drives, atMs, state.wearConfig),
  };
}

function matchesEntry(driveEntry: DriveEntry, matcher: DriveState["satiatedBy"][number]["matches"]): boolean {
  if (driveEntry.kind !== matcher.kind || driveEntry.type !== matcher.type) return false;
  if (matcher.predicate === undefined) return true;
  if (matcher.kind === "event" && driveEntry.kind === "event") return matcher.predicate(driveEntry);
  if (matcher.kind === "action" && driveEntry.kind === "action") return matcher.predicate(driveEntry);
  return false;
}

export function integrateDriveEntry(
  state: DriveSystemState,
  entry: DriveEntry,
  causeEventId?: string,
): DriveIntegrationResult {
  if (entry.type.trim().length === 0) throw new TypeError("drive entry type must not be empty");
  if (causeEventId !== undefined && causeEventId.trim().length === 0) {
    throw new TypeError("causeEventId must not be empty");
  }
  const drives = new Map<string, DriveState>();
  const satiations = [];
  for (const [id, drive] of state.drives) {
    let requested = 0;
    for (const binding of drive.satiatedBy) {
      if (matchesEntry(entry, binding.matches)) requested += binding.amount;
    }
    if (requested > 0) {
      const after = clamp01(drive.level + requested);
      drives.set(id, { ...drive, level: after });
      satiations.push({
        atMs: state.elapsedMs,
        driveId: id,
        before: drive.level,
        after,
        requested,
        entry,
        ...(causeEventId === undefined ? {} : { causeEventId }),
      });
    } else {
      drives.set(id, drive);
    }
  }
  const next = { ...state, drives };
  return {
    state: next,
    satiations,
    wearTransitions: transitionsBetween(
      state.drives,
      drives,
      state.elapsedMs,
      state.wearConfig,
      causeEventId,
    ),
  };
}

export function summarizeDrives(state: DriveSystemState): DriveSummary[] {
  return [...state.drives.values()]
    .map((drive) => {
      const tracker = state.wear.perDrive.get(drive.id);
      return {
        id: drive.id,
        name: drive.name,
        tier: drive.tier,
        level: drive.level,
        target: drive.target,
        pressure: weightedPressure(drive),
        chronic:
          tracker !== undefined &&
          tracker.sustainedBelowMs > 0 &&
          tracker.sustainedAboveMs < state.wearConfig.recoveryHorizonMs,
      };
    })
    .sort((left, right) => right.pressure - left.pressure || compareCodeUnits(left.id, right.id));
}

export function snapshotDriveSystem(state: DriveSystemState): DriveSystemSnapshot {
  return {
    actorId: state.actorId,
    elapsedMs: state.elapsedMs,
    levels: Object.fromEntries([...state.drives].map(([id, drive]) => [id, drive.level])),
    wear: {
      perDrive: Object.fromEntries(state.wear.perDrive),
      chronicLoad: state.wear.chronicLoad,
    },
  };
}

export function restoreDriveSystem(
  config: DriveSystemConfig,
  snapshot: DriveSystemSnapshot,
): DriveSystemState {
  const initial = createDriveSystem(config);
  if (snapshot.actorId !== initial.actorId) throw new DriveConfigError("snapshot actorId does not match config");
  if (!Number.isFinite(snapshot.elapsedMs) || snapshot.elapsedMs < 0) {
    throw new DriveConfigError("snapshot elapsedMs must be finite and non-negative");
  }
  const levelIds = Object.keys(snapshot.levels).sort();
  const driveIds = [...initial.drives.keys()].sort();
  if (JSON.stringify(levelIds) !== JSON.stringify(driveIds)) {
    throw new DriveConfigError("snapshot drive ids do not match config");
  }
  const drives = new Map<string, DriveState>();
  for (const [id, drive] of initial.drives) {
    const level = snapshot.levels[id];
    if (level === undefined) throw new DriveConfigError(`snapshot is missing drive ${id}`);
    requireUnit(level, `snapshot level for drive ${id}`);
    drives.set(id, { ...drive, level });
  }
  requireUnit(snapshot.wear.chronicLoad, "snapshot chronicLoad");
  const trackers = new Map<string, ChronicTracker>();
  for (const [id, tracker] of Object.entries(snapshot.wear.perDrive)) {
    if (!drives.has(id)) throw new DriveConfigError(`snapshot wear contains unknown drive ${id}`);
    if (
      !Number.isFinite(tracker.sustainedBelowMs) ||
      !Number.isFinite(tracker.sustainedAboveMs) ||
      tracker.sustainedBelowMs < 0 ||
      tracker.sustainedAboveMs < 0
    ) {
      throw new DriveConfigError(`snapshot wear tracker for ${id} is invalid`);
    }
    trackers.set(id, { ...tracker });
  }
  return {
    ...initial,
    elapsedMs: snapshot.elapsedMs,
    drives,
    wear: { perDrive: trackers, chronicLoad: snapshot.wear.chronicLoad },
  };
}
