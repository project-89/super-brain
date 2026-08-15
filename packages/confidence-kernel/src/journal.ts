import type { HistoryRun, Journal } from './types.js';

/** Runs matching a tag query: a run with no tags matches only an empty query. */
function matches(run: HistoryRun, tags?: string[]): boolean {
  if (!tags || tags.length === 0) return true;
  return !!run.tags && run.tags.some((t) => tags.includes(t));
}

function applyQuery(
  runs: HistoryRun[],
  query?: { tags?: string[]; limit?: number }
): HistoryRun[] {
  let out = runs.filter((r) => matches(r, query?.tags));
  out = [...out].sort((a, b) => b.timestamp - a.timestamp);
  if (query?.limit != null) out = out.slice(0, query.limit);
  return out;
}

/** In-memory reference journal. Newest-first on load. */
export class InMemoryJournal implements Journal {
  private runs: HistoryRun[] = [];

  constructor(seed: HistoryRun[] = []) {
    this.runs = [...seed];
  }

  async append(run: HistoryRun): Promise<void> {
    this.runs.push(run);
  }

  async load(query?: { tags?: string[]; limit?: number }): Promise<HistoryRun[]> {
    return applyQuery(this.runs, query);
  }
}

/**
 * Append-only JSONL reference journal (one JSON run per line).
 *
 * Filesystem access is injected so the kernel stays dependency- and
 * environment-free: pass Node's `fs/promises` (or any compatible shim). Nothing
 * here imports `node:fs` directly.
 */
export interface JsonlFs {
  appendFile(path: string, data: string): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}

export class JsonlJournal implements Journal {
  constructor(
    private readonly path: string,
    private readonly fs: JsonlFs
  ) {}

  async append(run: HistoryRun): Promise<void> {
    await this.fs.appendFile(this.path, JSON.stringify(run) + '\n');
  }

  async load(query?: { tags?: string[]; limit?: number }): Promise<HistoryRun[]> {
    let text: string;
    try {
      text = await this.fs.readFile(this.path, 'utf8');
    } catch {
      return [];
    }
    const runs: HistoryRun[] = [];
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        runs.push(JSON.parse(trimmed) as HistoryRun);
      } catch {
        /* skip malformed lines */
      }
    }
    return applyQuery(runs, query);
  }
}
