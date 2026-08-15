import { scoreHistory } from './score.js';
import type {
  HistoryRun,
  Oracle,
  OracleResult,
  ScoreOptions,
  ScoreResult,
} from './types.js';

/** How to fold several oracle results into one. */
export type CombineStrategy = 'min' | 'mean';

/**
 * Combine oracle results. Default `min` — "a result is only as trustworthy as
 * its weakest check" (Parallax's rule). This is what keeps a supplementary prior
 * from ever *raising* confidence above a real check: min-combined, it can only
 * pull the number down.
 *
 * Empty input returns a neutral 1.0 (nothing to distrust).
 */
export function combine(
  results: OracleResult[],
  strategy: CombineStrategy = 'min'
): OracleResult {
  if (results.length === 0) return { confidence: 1 };

  if (strategy === 'mean') {
    const confidence =
      results.reduce((a, r) => a + r.confidence, 0) / results.length;
    return { confidence, detail: joinDetails(results) };
  }

  let winner = results[0]!;
  for (const r of results) if (r.confidence < winner.confidence) winner = r;
  return { confidence: winner.confidence, detail: joinDetails(results) };
}

function joinDetails(results: OracleResult[]): string | undefined {
  const parts = results
    .map((r) => r.detail)
    .filter((d): d is string => !!d);
  return parts.length ? parts.join('\n') : undefined;
}

export interface HistoryOracleOptions<S = unknown> extends ScoreOptions {
  /**
   * Confidence to emit when the prior is too thin (scoreHistory returns null).
   * Defaults to 1.0 (neutral) so a missing prior never gates. Hosts using the
   * `skip` posture as a hard gate may prefer 0.
   */
  neutral?: number;
  /**
   * Resolve the efficiency term per subject, overriding {@link ScoreOptions.efficiency}.
   *
   * `ScoreOptions.efficiency` is fixed when the oracle is constructed, which is
   * wrong for hosts whose efficiency notion varies by subject and is loaded
   * alongside the runs — e.g. a per-role clean-decision rate. Receives the
   * subject and its loaded runs, and may be async.
   */
  resolveEfficiency?: (
    subject: S,
    runs: HistoryRun[]
  ) => number | Promise<number>;
  /**
   * Format the oracle's `detail` string. Lets a host keep its own wording
   * instead of the kernel's default. Receives `null` when the prior was too
   * thin to score (the neutral path).
   */
  formatDetail?: (
    score: ScoreResult | null,
    subject: S,
    runs: HistoryRun[]
  ) => string;
}

/**
 * Build a history verification oracle backed by a run loader.
 *
 * `loadRuns(subject)` returns the runs relevant to the subject being verified
 * (a host maps its own key — pattern+role, edge id, skill id — onto a query).
 * The oracle scores them via {@link scoreHistory} and emits the confidence, or
 * the neutral fallback when the prior is too thin.
 */
export function makeHistoryOracle<S>(
  loadRuns: (subject: S) => Promise<HistoryRun[]> | HistoryRun[],
  opts: HistoryOracleOptions<S>
): Oracle<S> {
  const neutral = opts.neutral ?? 1.0;
  return {
    type: 'history',
    async signal(subject: S): Promise<OracleResult> {
      const runs = await loadRuns(subject);
      const efficiency = opts.resolveEfficiency
        ? await opts.resolveEfficiency(subject, runs)
        : opts.efficiency;
      const score = scoreHistory(runs, { ...opts, efficiency });
      const detail = opts.formatDetail
        ? opts.formatDetail(score, subject, runs)
        : score
          ? score.detail
          : `history — ${runs.length} run(s) (min ${opts.minRuns ?? 0}): neutral`;
      return {
        confidence: score ? score.confidence : neutral,
        detail,
      };
    },
  };
}
