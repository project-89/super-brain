import { describe, it, expect } from 'vitest';
import { scoreHistory, type HistoryRun } from '../src/index.js';

/**
 * Golden tests: independently reimplement each host's *current* scoring formula
 * (exactly as it exists in that repo today) and assert the kernel reproduces it
 * bit-for-bit across a range of inputs. This is the safety net that lets each
 * migration PR claim "behavior-preserving".
 */

const T0 = 1_700_000_000_000;
const day = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// decision-pathfinder — RecommendationEngine.ts
//   decay:  exp(-ageDays * ln2 / halfLife), halfLife 30
//   rate:   weightedSuccesses / weightedTotal
//   sample: min(weightedTotal / 10, 1)
//   eff:    shortestSuccessLength(global) / avgSuccessLength(edge)   [host-supplied]
//   conf:   rate * sample * eff
// ---------------------------------------------------------------------------
function dpReference(
  runs: HistoryRun[],
  globalShortest: number,
  now: number
): number {
  let wTotal = 0;
  let wSucc = 0;
  const succLens: number[] = [];
  for (const r of runs) {
    const ageDays = (now - r.timestamp) / day;
    const w = Math.exp((-Math.max(ageDays, 0) * Math.LN2) / 30);
    wTotal += w;
    if (r.outcome === 'success') {
      wSucc += w;
      if (typeof r.steps === 'number') succLens.push(r.steps);
    }
  }
  const rate = wTotal > 0 ? wSucc / wTotal : 0;
  const sample = Math.min(wTotal / 10, 1);
  const avg = succLens.reduce((a, b) => a + b, 0) / succLens.length;
  const eff = globalShortest / avg;
  return rate * sample * eff;
}

describe('golden: decision-pathfinder (skip)', () => {
  it('reproduces rate × sample × efficiency with e-decay', () => {
    const runs: HistoryRun[] = [
      { id: 'a', outcome: 'success', steps: 6, timestamp: T0 - 2 * day },
      { id: 'b', outcome: 'success', steps: 6, timestamp: T0 - 5 * day },
      { id: 'c', outcome: 'failure', steps: 9, timestamp: T0 - 1 * day },
      { id: 'd', outcome: 'success', steps: 6, timestamp: T0 - 40 * day },
    ];
    const globalShortest = 3; // shortest known success across the whole tree
    const expected = dpReference(runs, globalShortest, T0);

    // avg successful length = 6 → host supplies eff = globalShortest / avg = 3/6
    const s = scoreHistory(runs, {
      posture: 'skip',
      halfLifeDays: 30,
      saturationRuns: 10,
      decayBase: 'e',
      efficiency: globalShortest / 6,
      now: T0,
    })!;
    expect(s.confidence).toBeCloseTo(expected, 12);
  });

  it('saturates to full confidence with 10 recent clean successes', () => {
    const runs: HistoryRun[] = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      outcome: 'success' as const,
      steps: 3,
      timestamp: T0,
    }));
    const s = scoreHistory(runs, {
      posture: 'skip',
      halfLifeDays: 30,
      saturationRuns: 10,
      decayBase: 'e',
      efficiency: 3 / 3,
      now: T0,
    })!;
    expect(s.confidence).toBeCloseTo(1, 12);
    expect(s.confidence).toBeGreaterThanOrEqual(0.6); // would trigger DP's ≥0.6 override
  });
});

// ---------------------------------------------------------------------------
// Parallax — decision-history.ts scoreDecisionHistory()
//   decay:  2^(-ageDays / halfLife), halfLife 30
//   rate:   weightedSuccess / weightSum
//   eff:    clean-decision rate (host-supplied number)
//   sample: min(weightSum / saturationRuns, 1)
//   raw:    rate * eff
//   conf:   1 - sample * (1 - raw)
//   minRuns 3 → neutral (null here; host emits 1.0)
// ---------------------------------------------------------------------------
function pxReference(
  runs: HistoryRun[],
  cleanRate: number,
  saturationRuns: number,
  now: number
): number {
  let wSum = 0;
  let wSucc = 0;
  for (const r of runs) {
    const ageDays = (now - r.timestamp) / day;
    const w = Math.pow(2, -Math.max(ageDays, 0) / 30);
    wSum += w;
    if (r.outcome === 'success') wSucc += w;
  }
  const rate = wSum > 0 ? wSucc / wSum : 0;
  const raw = rate * cleanRate;
  const sample = Math.min(wSum / saturationRuns, 1);
  return 1 - sample * (1 - raw);
}

describe('golden: Parallax (suppress)', () => {
  it('reproduces 1 - sample*(1-raw) with 2-decay and host clean rate', () => {
    const runs: HistoryRun[] = [
      { id: 'a', outcome: 'success', timestamp: T0 - 3 * day },
      { id: 'b', outcome: 'failure', timestamp: T0 - 10 * day },
      { id: 'c', outcome: 'success', timestamp: T0 - 15 * day },
      { id: 'd', outcome: 'success', timestamp: T0 - 45 * day },
      { id: 'e', outcome: 'success', timestamp: T0 - 1 * day },
    ];
    const cleanRate = 0.8;
    const saturationRuns = 8;
    const expected = pxReference(runs, cleanRate, saturationRuns, T0);

    const s = scoreHistory(runs, {
      posture: 'suppress',
      halfLifeDays: 30,
      saturationRuns,
      decayBase: '2',
      efficiency: cleanRate,
      minRuns: 3,
      now: T0,
    })!;
    expect(s.confidence).toBeCloseTo(expected, 12);
  });

  it('returns null (→ host neutral) below minRuns=3', () => {
    const runs: HistoryRun[] = [
      { id: 'a', outcome: 'success', timestamp: T0 },
      { id: 'b', outcome: 'success', timestamp: T0 },
    ];
    expect(
      scoreHistory(runs, {
        posture: 'suppress',
        halfLifeDays: 30,
        saturationRuns: 8,
        efficiency: 1,
        minRuns: 3,
        now: T0,
      })
    ).toBeNull();
  });

  it('a weak/sparse prior stays near neutral (never gates a costly action)', () => {
    const runs: HistoryRun[] = [
      { id: 'a', outcome: 'failure', timestamp: T0 },
      { id: 'b', outcome: 'failure', timestamp: T0 },
      { id: 'c', outcome: 'success', timestamp: T0 },
    ];
    const s = scoreHistory(runs, {
      posture: 'suppress',
      halfLifeDays: 30,
      saturationRuns: 50, // far from saturation → sample tiny
      efficiency: 1,
      minRuns: 3,
      now: T0,
    })!;
    // even with 33% success, sparse sample keeps confidence high (neutral-ish)
    expect(s.confidence).toBeGreaterThan(0.95);
  });
});
