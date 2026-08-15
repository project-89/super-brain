import { describe, it, expect } from 'vitest';
import { pool, type HistoryRun } from '../src/index.js';

const T0 = 1_700_000_000_000;
const day = 24 * 60 * 60 * 1000;

describe('pool', () => {
  const byTag = new Map<string, HistoryRun[]>([
    ['deploy-web', [
      { id: 'w1', outcome: 'success', timestamp: T0 - 1 * day, tags: ['deploy-web'] },
      { id: 'shared', outcome: 'success', timestamp: T0 - 2 * day, tags: ['deploy-web', 'deploy-api'] },
    ]],
    ['deploy-api', [
      { id: 'a1', outcome: 'failure', timestamp: T0 - 3 * day, tags: ['deploy-api'] },
      { id: 'shared', outcome: 'success', timestamp: T0 - 2 * day, tags: ['deploy-web', 'deploy-api'] },
    ]],
  ]);

  it('merges sibling buckets for cold-start transfer', () => {
    const merged = pool(byTag, ['deploy-web', 'deploy-api']);
    expect(merged.map((r) => r.id)).toEqual(['w1', 'shared', 'a1']);
  });

  it('de-duplicates a run that appears under multiple tags', () => {
    const merged = pool(byTag, ['deploy-web', 'deploy-api']);
    expect(merged.filter((r) => r.id === 'shared')).toHaveLength(1);
  });

  it('returns newest-first', () => {
    const merged = pool(byTag, ['deploy-web', 'deploy-api']);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i - 1]!.timestamp).toBeGreaterThanOrEqual(merged[i]!.timestamp);
    }
  });

  it('ignores unknown tags', () => {
    expect(pool(byTag, ['does-not-exist'])).toEqual([]);
  });
});
