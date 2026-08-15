import { describe, it, expect } from 'vitest';
import {
  ageDecayWeight,
  efficiencyFactor,
  scoreHistory,
  type HistoryRun,
} from '../src/index.js';

const T0 = 1_700_000_000_000; // fixed "now" for determinism
const day = 24 * 60 * 60 * 1000;

function run(
  partial: Partial<HistoryRun> & { outcome: 'success' | 'failure' }
): HistoryRun {
  return { id: Math.random().toString(36), timestamp: T0, ...partial };
}

describe('ageDecayWeight', () => {
  it('is 1 for a brand-new run', () => {
    expect(ageDecayWeight(0, 30)).toBe(1);
  });
  it('is 0.5 at exactly one half-life', () => {
    expect(ageDecayWeight(30, 30)).toBeCloseTo(0.5, 12);
    expect(ageDecayWeight(7, 7, 'e')).toBeCloseTo(0.5, 12);
  });
  it("base 'e' and base '2' are mathematically identical", () => {
    for (const age of [1, 5, 13, 30, 61, 150]) {
      expect(ageDecayWeight(age, 30, 'e')).toBeCloseTo(
        ageDecayWeight(age, 30, '2'),
        12
      );
    }
  });
  it('disables decay for non-positive / non-finite half-life', () => {
    expect(ageDecayWeight(100, 0)).toBe(1);
    expect(ageDecayWeight(100, -5)).toBe(1);
    expect(ageDecayWeight(100, Infinity)).toBe(1);
  });
  it('clamps negative age to 0', () => {
    expect(ageDecayWeight(-10, 30)).toBe(1);
  });
});

describe('efficiencyFactor', () => {
  it('rewards shorter successful runs (shortest/avg)', () => {
    const runs = [run({ outcome: 'success', steps: 3 }), run({ outcome: 'success', steps: 9 })];
    expect(efficiencyFactor(runs)).toBeCloseTo(3 / 6, 12);
  });
  it('is 1 with no usable step data', () => {
    expect(efficiencyFactor([run({ outcome: 'success' })])).toBe(1);
    expect(efficiencyFactor([])).toBe(1);
  });
});

describe('scoreHistory posture', () => {
  const runs = [
    run({ outcome: 'success', steps: 4 }),
    run({ outcome: 'success', steps: 4 }),
    run({ outcome: 'failure', steps: 4 }),
    run({ outcome: 'success', steps: 4 }),
  ];

  it('skip: sparse history shrinks toward 0', () => {
    const s = scoreHistory(runs, {
      posture: 'skip',
      halfLifeDays: 30,
      saturationRuns: 100, // deliberately far from saturation
      now: T0,
    })!;
    // weightSum=4, sample=4/100=0.04, rate=0.75, eff=1 → raw=0.75, conf=0.75*0.04
    expect(s.sample).toBeCloseTo(0.04, 12);
    expect(s.raw).toBeCloseTo(0.75, 12);
    expect(s.confidence).toBeCloseTo(0.75 * 0.04, 12);
  });

  it('suppress: sparse history shrinks toward neutral 1.0', () => {
    const s = scoreHistory(runs, {
      posture: 'suppress',
      halfLifeDays: 30,
      saturationRuns: 100,
      now: T0,
    })!;
    // conf = 1 - sample*(1-raw) = 1 - 0.04*(1-0.75)
    expect(s.confidence).toBeCloseTo(1 - 0.04 * (1 - 0.75), 12);
    expect(s.confidence).toBeGreaterThan(0.9); // near neutral
  });

  it('skip and suppress agree at full saturation', () => {
    const opts = { halfLifeDays: 30, saturationRuns: 4, now: T0 } as const;
    const skip = scoreHistory(runs, { ...opts, posture: 'skip' })!;
    const suppress = scoreHistory(runs, { ...opts, posture: 'suppress' })!;
    // sample=1 → skip: raw*1=raw ; suppress: 1-(1-raw)=raw
    expect(skip.confidence).toBeCloseTo(suppress.confidence, 12);
    expect(skip.confidence).toBeCloseTo(skip.raw, 12);
  });

  it('accepts a fixed host-supplied efficiency number', () => {
    const s = scoreHistory(runs, {
      posture: 'suppress',
      halfLifeDays: 30,
      saturationRuns: 4,
      efficiency: 0.5,
      now: T0,
    })!;
    expect(s.raw).toBeCloseTo(0.75 * 0.5, 12);
  });

  it('returns null below minRuns', () => {
    expect(
      scoreHistory(runs.slice(0, 2), {
        posture: 'suppress',
        halfLifeDays: 30,
        saturationRuns: 4,
        minRuns: 3,
        now: T0,
      })
    ).toBeNull();
  });

  it('older runs count less (decay lowers a stale success rate)', () => {
    const mixed = [
      run({ outcome: 'success', timestamp: T0 }), // fresh success
      run({ outcome: 'failure', timestamp: T0 - 60 * day }), // stale failure, ~0.25 weight
    ];
    const s = scoreHistory(mixed, {
      posture: 'skip',
      halfLifeDays: 30,
      saturationRuns: 1,
      now: T0,
    })!;
    // stale failure barely counts → success rate well above 0.5
    expect(s.raw).toBeGreaterThan(0.75);
  });
});
