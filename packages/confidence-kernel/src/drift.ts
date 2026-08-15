import type { HistoryRun } from './types.js';

export interface DriftOptions {
  /** How many of the most-recent runs form the "recent" window. */
  recentN: number;
  /**
   * How far recent success rate may fall below lifetime before it counts as
   * drift. e.g. 0.2 → recent is flagged when it is >0.2 below lifetime.
   */
  driftThreshold: number;
  /** Minimum total runs before drift is even evaluated. Defaults to `recentN`. */
  minRuns?: number;
}

export interface DriftResult {
  recentScore: number;
  lifetimeScore: number;
  drifted: boolean;
}

/**
 * Detect silent regression by comparing the recent window's success rate to the
 * lifetime rate. Generalized from reasoning-tree's skill-health drift check.
 *
 * `runs` may be in any order; the most recent `recentN` by `timestamp` form the
 * recent window. Returns `drifted: false` until there are at least `minRuns`
 * runs. A host uses this to demote/suppress a prior whose success just collapsed
 * instead of waiting for slow age decay to catch up.
 */
export function detectDrift(
  runs: HistoryRun[],
  opts: DriftOptions
): DriftResult {
  const { recentN, driftThreshold, minRuns = recentN } = opts;
  const successRate = (list: HistoryRun[]): number =>
    list.length === 0
      ? 0
      : list.filter((r) => r.outcome === 'success').length / list.length;

  const lifetimeScore = successRate(runs);

  if (runs.length < minRuns || recentN <= 0) {
    return { recentScore: lifetimeScore, lifetimeScore, drifted: false };
  }

  const recent = [...runs]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, recentN);
  const recentScore = successRate(recent);

  return {
    recentScore,
    lifetimeScore,
    drifted: lifetimeScore - recentScore > driftThreshold,
  };
}
