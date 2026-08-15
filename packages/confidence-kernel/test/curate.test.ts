import { describe, it, expect } from 'vitest';
import { applyProbation, shouldRetire, type HistoryRun } from '../src/index.js';

const T0 = 1_700_000_000_000;
const runs = (outcomes: ('success' | 'failure')[]): HistoryRun[] =>
  outcomes.map((outcome, i) => ({ id: `r${i}`, outcome, timestamp: T0 + i }));

const probation = { probationRuns: 3, successBonus: 0.1, failureCeiling: 0.5 };

describe('applyProbation', () => {
  it('nudges health up on a probation success', () => {
    const r = applyProbation(0.8, runs(['success']), probation);
    expect(r.onProbation).toBe(true);
    expect(r.health).toBeCloseTo(0.9, 12);
  });

  it('clips health on a probation failure', () => {
    const r = applyProbation(0.8, runs(['failure']), probation);
    expect(r.health).toBe(0.5);
    expect(r.onProbation).toBe(true);
  });

  it('passes health through once past probation', () => {
    const r = applyProbation(0.72, runs(['success', 'success', 'success']), probation);
    expect(r.onProbation).toBe(false);
    expect(r.health).toBeCloseTo(0.72, 12);
  });

  it('clamps the bonus at 1.0', () => {
    expect(applyProbation(0.98, runs(['success']), probation).health).toBe(1);
  });
});

describe('shouldRetire', () => {
  it('retires only after minRuns and below threshold', () => {
    const opts = { retireThreshold: 0.3, minRuns: 2 };
    expect(shouldRetire(0.2, runs(['failure', 'failure']), opts)).toBe(true);
    expect(shouldRetire(0.2, runs(['failure']), opts)).toBe(false); // too few runs
    expect(shouldRetire(0.5, runs(['success', 'success']), opts)).toBe(false); // healthy
  });
});
