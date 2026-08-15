import { describe, it, expect } from 'vitest';
import {
  combine,
  makeHistoryOracle,
  type HistoryRun,
  type Oracle,
} from '../src/index.js';

const T0 = 1_700_000_000_000;

describe('combine', () => {
  it('min: only as trustworthy as the weakest check', () => {
    const r = combine([{ confidence: 0.9 }, { confidence: 0.4 }, { confidence: 1 }]);
    expect(r.confidence).toBe(0.4);
  });
  it('a supplement can lower but never raise the winner', () => {
    // real oracle 0.7, history 1.0 (neutral) → min stays 0.7
    expect(combine([{ confidence: 0.7 }, { confidence: 1.0 }]).confidence).toBe(0.7);
    // history 0.3 pulls it down
    expect(combine([{ confidence: 0.7 }, { confidence: 0.3 }]).confidence).toBe(0.3);
  });
  it('mean averages', () => {
    expect(combine([{ confidence: 0.4 }, { confidence: 0.6 }], 'mean').confidence).toBeCloseTo(0.5, 12);
  });
  it('empty is neutral 1.0', () => {
    expect(combine([]).confidence).toBe(1);
  });
  it('concatenates details', () => {
    const r = combine([{ confidence: 1, detail: 'a' }, { confidence: 0.5, detail: 'b' }]);
    expect(r.detail).toBe('a\nb');
  });
});

describe('makeHistoryOracle', () => {
  const goodRuns: HistoryRun[] = Array.from({ length: 5 }, (_, i) => ({
    id: `g${i}`,
    outcome: 'success' as const,
    steps: 3,
    timestamp: T0,
  }));

  it('emits a scored confidence when the prior is sufficient', async () => {
    const oracle = makeHistoryOracle(async () => goodRuns, {
      posture: 'suppress',
      halfLifeDays: 30,
      saturationRuns: 5,
      minRuns: 3,
      now: T0,
    });
    const r = await oracle.signal(undefined);
    expect(r.confidence).toBeCloseTo(1, 12); // all success, saturated
    expect(oracle.type).toBe('history');
  });

  it('emits neutral fallback when the prior is too thin', async () => {
    const oracle = makeHistoryOracle(async () => goodRuns.slice(0, 1), {
      posture: 'suppress',
      halfLifeDays: 30,
      saturationRuns: 5,
      minRuns: 3,
      neutral: 1.0,
      now: T0,
    });
    const r = await oracle.signal(undefined);
    expect(r.confidence).toBe(1.0);
    expect(r.detail).toContain('neutral');
  });

  it('resolves efficiency per subject, overriding the fixed option', async () => {
    // The Parallax case: efficiency is a per-role clean-decision rate loaded
    // alongside the runs, so it cannot be fixed at construction time.
    const cleanRateByRole: Record<string, number> = { eng: 1.0, qa: 0.5 };
    const oracle = makeHistoryOracle<string>(async () => goodRuns, {
      posture: 'suppress',
      halfLifeDays: 30,
      saturationRuns: 5,
      minRuns: 3,
      efficiency: 0.1, // fixed value that must be overridden
      resolveEfficiency: (role) => cleanRateByRole[role] ?? 1,
      now: T0,
    });
    // all-success + saturated → confidence tracks efficiency directly
    expect((await oracle.signal('eng')).confidence).toBeCloseTo(1.0, 12);
    expect((await oracle.signal('qa')).confidence).toBeCloseTo(0.5, 12);
  });

  it('supports an async efficiency resolver', async () => {
    const oracle = makeHistoryOracle<string>(async () => goodRuns, {
      posture: 'suppress',
      halfLifeDays: 30,
      saturationRuns: 5,
      minRuns: 3,
      resolveEfficiency: async () => 0.25,
      now: T0,
    });
    expect((await oracle.signal('any')).confidence).toBeCloseTo(0.25, 12);
  });

  it('lets the host format its own detail string, on both paths', async () => {
    const opts = {
      posture: 'suppress' as const,
      halfLifeDays: 30,
      saturationRuns: 5,
      minRuns: 3,
      formatDetail: (score: unknown, subject: string, runs: HistoryRun[]) =>
        score
          ? `${subject}: scored over ${runs.length} run(s)`
          : `${subject}: too thin (${runs.length})`,
      now: T0,
    };
    const scored = makeHistoryOracle<string>(async () => goodRuns, opts);
    expect((await scored.signal('engineer')).detail).toBe(
      'engineer: scored over 5 run(s)'
    );
    const thin = makeHistoryOracle<string>(async () => goodRuns.slice(0, 1), opts);
    expect((await thin.signal('engineer')).detail).toBe('engineer: too thin (1)');
  });

  it('is subordinate under min-combine with a real oracle', async () => {
    const history = makeHistoryOracle(async () => goodRuns, {
      posture: 'suppress',
      halfLifeDays: 30,
      saturationRuns: 5,
      minRuns: 3,
      now: T0,
    });
    const failingTests: Oracle<unknown> = {
      type: 'command',
      async signal() {
        return { confidence: 0.2, detail: 'tests failing' };
      },
    };
    const combined = combine([
      await failingTests.signal(undefined),
      await history.signal(undefined),
    ]);
    // history is confident (1.0) but cannot outvote failing tests
    expect(combined.confidence).toBe(0.2);
  });
});
