import { describe, it, expect } from 'vitest';
import {
  InMemoryJournal,
  JsonlJournal,
  type HistoryRun,
  type JsonlFs,
} from '../src/index.js';

const T0 = 1_700_000_000_000;

function mk(id: string, ts: number, tags?: string[]): HistoryRun {
  return { id, outcome: 'success', timestamp: ts, tags };
}

describe('InMemoryJournal', () => {
  it('appends and loads newest-first', async () => {
    const j = new InMemoryJournal();
    await j.append(mk('a', T0));
    await j.append(mk('b', T0 + 100));
    const loaded = await j.load();
    expect(loaded.map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('filters by tag and respects limit', async () => {
    const j = new InMemoryJournal([
      mk('a', T0, ['x']),
      mk('b', T0 + 1, ['y']),
      mk('c', T0 + 2, ['x']),
    ]);
    const xs = await j.load({ tags: ['x'] });
    expect(xs.map((r) => r.id)).toEqual(['c', 'a']);
    expect((await j.load({ limit: 1 })).map((r) => r.id)).toEqual(['c']);
  });
});

describe('JsonlJournal', () => {
  function fakeFs(): JsonlFs & { store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      store,
      async appendFile(path, data) {
        store.set(path, (store.get(path) ?? '') + data);
      },
      async readFile(path) {
        const v = store.get(path);
        if (v == null) throw new Error('ENOENT');
        return v;
      },
    };
  }

  it('round-trips runs as one JSON object per line', async () => {
    const fs = fakeFs();
    const j = new JsonlJournal('/x.jsonl', fs);
    await j.append(mk('a', T0));
    await j.append(mk('b', T0 + 1));
    expect(fs.store.get('/x.jsonl')!.split('\n').filter(Boolean)).toHaveLength(2);
    expect((await j.load()).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('returns [] when the file does not exist', async () => {
    const j = new JsonlJournal('/missing.jsonl', fakeFs());
    expect(await j.load()).toEqual([]);
  });

  it('skips malformed lines', async () => {
    const fs = fakeFs();
    fs.store.set('/x.jsonl', JSON.stringify(mk('a', T0)) + '\n{bad json\n');
    const j = new JsonlJournal('/x.jsonl', fs);
    expect((await j.load()).map((r) => r.id)).toEqual(['a']);
  });
});
