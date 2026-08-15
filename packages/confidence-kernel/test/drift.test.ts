import { describe, it, expect } from 'vitest';
import { detectDrift, type HistoryRun } from '../src/index.js';

const day = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function seq(outcomes: ('success' | 'failure')[]): HistoryRun[] {
  // index 0 is oldest
  return outcomes.map((outcome, i) => ({
    id: `r${i}`,
    outcome,
    timestamp: T0 + i * day,
  }));
}

describe('detectDrift', () => {
  it('flags a recent collapse in success rate', () => {
    // lifetime mostly success, but the recent 5 are mostly failure
    const runs = seq([
      'success', 'success', 'success', 'success', 'success',
      'failure', 'failure', 'failure', 'failure', 'success',
    ]);
    const d = detectDrift(runs, { recentN: 5, driftThreshold: 0.2 });
    expect(d.lifetimeScore).toBeCloseTo(0.6, 12);
    expect(d.recentScore).toBeCloseTo(0.2, 12); // 1 of last 5
    expect(d.drifted).toBe(true);
  });

  it('does not flag a healthy steady skill', () => {
    const runs = seq(['success', 'success', 'failure', 'success', 'success', 'success']);
    const d = detectDrift(runs, { recentN: 3, driftThreshold: 0.2 });
    expect(d.drifted).toBe(false);
  });

  it('stays quiet until minRuns is reached', () => {
    const runs = seq(['failure', 'failure']);
    const d = detectDrift(runs, { recentN: 5, driftThreshold: 0.2, minRuns: 5 });
    expect(d.drifted).toBe(false);
  });

  it('uses timestamp (not array order) to pick the recent window', () => {
    const runs: HistoryRun[] = [
      { id: 'old-fail', outcome: 'failure', timestamp: T0 },
      { id: 'new-fail-1', outcome: 'failure', timestamp: T0 + 10 * day },
      { id: 'new-fail-2', outcome: 'failure', timestamp: T0 + 11 * day },
      { id: 'mid-success', outcome: 'success', timestamp: T0 + 5 * day },
    ];
    const d = detectDrift(runs, { recentN: 2, driftThreshold: 0.1 });
    expect(d.recentScore).toBe(0); // two newest are both failures
    expect(d.drifted).toBe(true);
  });
});
