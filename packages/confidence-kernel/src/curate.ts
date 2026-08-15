import type { HistoryRun } from './types.js';

/**
 * Lifecycle helpers for the "curate" posture (reasoning-tree's skill library).
 *
 * Unlike `skip`/`suppress`, reasoning-tree does not reduce history to a single
 * multiplicative confidence — its skill health is a weighted mix of many
 * domain-specific signals (rubric, world-checks, answer quality, …). So the
 * kernel exposes the *primitives* it shares (age decay and efficiency live in
 * `score.ts`; drift in `drift.ts`) plus the lifecycle gates below, which a host
 * composes around its own health number. This keeps the curate host honest
 * about its richer signal without forcing it into the wrong formula.
 */

export interface ProbationOptions {
  /** Number of firings a new subject stays on probation. */
  probationRuns: number;
  /** Bonus added to health for a success during probation. */
  successBonus: number;
  /** Health ceiling applied after a failure during probation. */
  failureCeiling: number;
}

export interface ProbationResult {
  /** Health after applying the probation adjustment. */
  health: number;
  /** Whether the subject is still on probation after this run. */
  onProbation: boolean;
}

/**
 * Apply probation shaping to a freshly-computed health value.
 *
 * While a subject has fewer than `probationRuns` recorded runs, a success nudges
 * health up by `successBonus` and a failure clips it to `failureCeiling` — so a
 * lucky early streak can't inflate a new subject, and an early failure is
 * penalized hard. Once past probation, `health` passes through unchanged.
 */
export function applyProbation(
  health: number,
  runs: HistoryRun[],
  opts: ProbationOptions
): ProbationResult {
  const onProbation = runs.length < opts.probationRuns;
  if (!onProbation) return { health: clamp01(health), onProbation: false };

  const last = runs[runs.length - 1];
  let adjusted = health;
  if (last?.outcome === 'success') adjusted = health + opts.successBonus;
  else if (last?.outcome === 'failure') adjusted = Math.min(health, opts.failureCeiling);

  return { health: clamp01(adjusted), onProbation: true };
}

export interface FastKillOptions {
  /** Retire once health drops below this. */
  retireThreshold: number;
  /** …but only after at least this many runs (avoid killing on one fluke). */
  minRuns: number;
}

/**
 * Whether a subject should be retired: health below `retireThreshold` after at
 * least `minRuns` runs. Mirrors reasoning-tree's fast-kill.
 */
export function shouldRetire(
  health: number,
  runs: HistoryRun[],
  opts: FastKillOptions
): boolean {
  return runs.length >= opts.minRuns && health < opts.retireThreshold;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
