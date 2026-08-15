import type {
  DecayBase,
  HistoryRun,
  ScoreOptions,
  ScoreResult,
} from './types.js';

/**
 * Exponential age-decay weight for a run of a given age.
 *
 * `base:'2'` → `2^(-ageDays/halfLife)`   (matches Parallax's decision-history)
 * `base:'e'` → `exp(-ageDays·ln2/halfLife)` (matches decision-pathfinder)
 *
 * The two are mathematically equal; the option only exists to reproduce a host's
 * exact floating-point values during a behavior-preserving migration. A run
 * exactly `halfLife` days old contributes 0.5; a brand-new run contributes 1.0.
 * Non-positive or non-finite `halfLifeDays` disables decay (returns 1).
 */
export function ageDecayWeight(
  ageDays: number,
  halfLifeDays: number,
  base: DecayBase = '2'
): number {
  if (!(halfLifeDays > 0) || !Number.isFinite(halfLifeDays)) return 1;
  const age = Math.max(ageDays, 0);
  return base === 'e'
    ? Math.exp((-age * Math.LN2) / halfLifeDays)
    : Math.pow(2, -age / halfLifeDays);
}

/**
 * Default efficiency factor: `shortestSuccessfulSteps / averageSuccessfulSteps`.
 *
 * Rewards runs that succeed in few steps. Returns 1 when there is no usable
 * `steps` data (efficiency then contributes nothing to `raw`). Hosts whose
 * efficiency notion isn't step-based (e.g. a clean-decision rate) pass their own
 * number via {@link ScoreOptions.efficiency} instead.
 */
export function efficiencyFactor(successfulRuns: HistoryRun[]): number {
  const lengths = successfulRuns
    .map((r) => r.steps)
    .filter((s): s is number => typeof s === 'number' && s > 0);
  if (lengths.length === 0) return 1;
  const shortest = Math.min(...lengths);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  if (!(avg > 0)) return 1;
  return shortest / avg;
}

function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/**
 * Score an outcome-labelled history into a confidence prior.
 *
 * Ingredients (shared by every founding host):
 *   raw        = weightedSuccessRate × efficiency
 *   sample     = min(weightSum / saturationRuns, 1)
 *   confidence = posture-shaped(raw, sample)
 *
 * where each run's contribution is scaled by {@link ageDecayWeight}. The
 * `posture` knob is the only place the hosts diverge:
 *   - `skip`     → confidence = raw × sample          (sparse → 0)
 *   - `suppress` → confidence = 1 − sample × (1 − raw) (sparse → neutral 1.0)
 *
 * Returns `null` when there are fewer than `minRuns` runs — a prior too thin to
 * trust. The caller decides what null means (usually: emit a neutral signal).
 */
export function scoreHistory(
  runs: HistoryRun[],
  opts: ScoreOptions
): ScoreResult | null {
  const {
    posture,
    halfLifeDays,
    saturationRuns,
    minRuns = 0,
    decayBase = '2',
    now = nowMs(),
  } = opts;

  if (runs.length < minRuns) return null;

  const dayMs = 24 * 60 * 60 * 1000;
  let weightSum = 0;
  let weightedSuccess = 0;
  const successfulRuns: HistoryRun[] = [];

  for (const run of runs) {
    const ageDays = (now - run.timestamp) / dayMs;
    const weight = ageDecayWeight(ageDays, halfLifeDays, decayBase);
    weightSum += weight;
    if (run.outcome === 'success') {
      weightedSuccess += weight;
      successfulRuns.push(run);
    }
  }

  if (weightSum <= 0) return null;

  const successRate = weightedSuccess / weightSum;
  const efficiency =
    typeof opts.efficiency === 'number'
      ? clamp01(opts.efficiency)
      : clamp01((opts.efficiency ?? efficiencyFactor)(successfulRuns));

  const raw = clamp01(successRate * efficiency);
  const sample = saturationRuns > 0 ? Math.min(weightSum / saturationRuns, 1) : 1;

  const confidence =
    posture === 'skip'
      ? clamp01(raw * sample)
      : clamp01(1 - sample * (1 - raw));

  const detail =
    `history[${posture}] — ${runs.length} run(s), ` +
    `${(successRate * 100).toFixed(0)}% success × ${efficiency.toFixed(2)} eff, ` +
    `sample ${sample.toFixed(2)} → confidence ${confidence.toFixed(2)}`;

  return { confidence, raw, sample, weightSum, detail };
}

/**
 * `Date.now()` behind a wrapper so the rest of the module stays pure and tests
 * can inject `now`. Not exported.
 */
function nowMs(): number {
  return Date.now();
}
