/**
 * Normalized data model shared by all hosts.
 *
 * A host records its executions however it likes (JSONL, Prisma rows, in-memory
 * skill windows) and maps them onto {@link HistoryRun} at read time. The scoring
 * kernel only ever sees this shape — it never touches a storage engine.
 */

/** A single outcome-labelled run of some repeatable thing (an edge, a role, a skill). */
export interface HistoryRun {
  /** Stable identifier for the run. */
  id: string;
  /** Epoch milliseconds when the run started (used for age decay). */
  timestamp: number;
  /** Whether the run ultimately succeeded. */
  outcome: 'success' | 'failure';
  /**
   * Optional path length / tool-call count. Feeds the default efficiency factor
   * (shorter successful runs score higher). Omit when a host supplies its own
   * efficiency signal instead.
   */
  steps?: number;
  /** Optional tags for sibling/family pooling (e.g. pattern family, tree family). */
  tags?: string[];
  /** Arbitrary host metadata; ignored by the kernel. */
  metadata?: Record<string, unknown>;
}

/**
 * Risk posture — the one knob on which the three founding hosts diverge.
 *
 * - `skip`     — sparse history shrinks toward **0**. Correct when the
 *                low-confidence action is cheap/safe (e.g. "ask the LLM again").
 *                A confident prior is meant to *replace* work.
 *                `confidence = raw × sample`
 * - `suppress` — sparse history shrinks toward **neutral 1.0**. Correct when the
 *                low-confidence action is costly (retry, escalate) and the prior
 *                is only ever a supplement combined-by-min with real checks.
 *                `confidence = 1 − sample × (1 − raw)`
 *
 * (The "curate" lifecycle used by reasoning-tree is expressed via the primitives
 * in `curate.ts` composed into a host's own multi-signal health mix, not via a
 * single scoreHistory formula — see that module.)
 */
export type Posture = 'skip' | 'suppress';

/** Base for the exponential age-decay half-life. */
export type DecayBase = 'e' | '2';

export interface ScoreOptions {
  /** Which sparse-history behavior to use. */
  posture: Posture;
  /** Half-life in days for age decay. `<= 0` or non-finite disables decay. */
  halfLifeDays: number;
  /** Weighted-run count at which `sample` saturates to 1. */
  saturationRuns: number;
  /**
   * Below this many *raw* (unweighted) runs the prior is considered too thin to
   * trust and {@link scoreHistory} returns `null`. Hosts decide what a null
   * prior means (typically: emit neutral). Defaults to 0 (never thin).
   */
  minRuns?: number;
  /**
   * Decay base. `'e'` computes `exp(-ageDays·ln2/halfLife)`,
   * `'2'` computes `2^(-ageDays/halfLife)`. Mathematically identical; the option
   * exists only to reproduce a host's exact float values. Defaults to `'2'`.
   */
  decayBase?: DecayBase;
  /**
   * Efficiency factor in [0,1]. Either a fixed number (host supplies its own
   * signal — e.g. a clean-decision rate) or a function over the successful runs.
   * Defaults to {@link efficiencyFactor} (shortest / average successful steps).
   */
  efficiency?: number | ((successfulRuns: HistoryRun[]) => number);
  /** Current time in epoch ms. Injectable for deterministic tests. */
  now?: number;
}

export interface ScoreResult {
  /** Final confidence in [0,1], shaped by posture. */
  confidence: number;
  /** `weightedSuccessRate × efficiency`, before the posture/sample shaping. */
  raw: number;
  /** Sample-sufficiency factor `min(weightSum / saturationRuns, 1)` in [0,1]. */
  sample: number;
  /** Sum of decay weights across all runs (the "weighted run count"). */
  weightSum: number;
  /** Human-readable one-liner describing the score. */
  detail: string;
}

/** Result of a single verification oracle. */
export interface OracleResult {
  /** Confidence in [0,1]. */
  confidence: number;
  /** Optional human-readable explanation. */
  detail?: string;
}

/** A verification oracle over some subject `S`. */
export interface Oracle<S> {
  type: string;
  signal(subject: S): Promise<OracleResult>;
}

/**
 * The persistence seam. Hosts implement this over their own store; the kernel
 * ships only `InMemoryJournal` and `JsonlJournal` reference implementations.
 */
export interface Journal {
  append(run: HistoryRun): Promise<void>;
  load(query?: { tags?: string[]; limit?: number }): Promise<HistoryRun[]>;
}
