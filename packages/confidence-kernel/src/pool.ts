import type { HistoryRun } from './types.js';

/**
 * Merge runs from sibling/family buckets for cold-start transfer.
 *
 * Generalized from decision-pathfinder's family pooling: a brand-new subject
 * with no history of its own can borrow a prior from siblings sharing a family
 * tag, so it starts warm instead of neutral. De-duplicates by run `id` (a run
 * that appears under several tags is counted once) and returns runs sorted
 * newest-first.
 */
export function pool(
  runsByTag: Map<string, HistoryRun[]>,
  tags: string[]
): HistoryRun[] {
  const seen = new Set<string>();
  const merged: HistoryRun[] = [];
  for (const tag of tags) {
    const runs = runsByTag.get(tag);
    if (!runs) continue;
    for (const run of runs) {
      if (seen.has(run.id)) continue;
      seen.add(run.id);
      merged.push(run);
    }
  }
  return merged.sort((a, b) => b.timestamp - a.timestamp);
}
