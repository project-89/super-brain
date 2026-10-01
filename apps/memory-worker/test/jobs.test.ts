import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEvent, type FoldEvent } from '@_89/fold';
import { makeTranscriptRunEvent, type TranscriptRun } from '@_89/fold-transcript';
import type { SuperBrainClient } from '@_89/super-brain-client';
import { DurableWorkerJobs, ProcessingBackpressureError, jobDigest, processingDigest } from '../src/jobs.js';
import { extractMemoryCandidatePage, TranscriptMemoryWorker } from '../src/index.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
const stores: DurableWorkerJobs[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function root() { const path = await mkdtemp(join(tmpdir(), 'worker-job-test-')); roots.push(path); return path; }
function launch(path: string) {
  const child = fork(fileURLToPath(new URL('./fixtures/job-lease-process.mjs', import.meta.url)), [path], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  const result = new Promise<string>((resolve, reject) => { child.once('message', (message) => resolve((message as { status: string }).status)); child.once('error', reject); child.once('exit', (code) => { if (code !== 0 && code !== 2) reject(new Error(`lease child exited ${code}`)); }); });
  return { child, result };
}

it('encrypts source work and serializes duplicate enqueue against terminal publication', async () => {
  const store = new DurableWorkerJobs(await root(), 'organization/workspace/principal/config'); stores.push(store);
  await Promise.all([store.open(), store.open()]);
  const job = await store.enqueue('propose', 'same-source', { privateSource: 'secret source excerpt' }, 100);
  await Promise.all([store.put({ ...job, state: 'completed', updatedAt: 101 }), store.enqueue('propose', 'same-source', { privateSource: 'secret source excerpt' }, 102)]);
  expect((await store.get(job.id))?.state).toBe('completed');
  expect(await store.active()).toEqual([]);
  const bytes = await readFile(join(store.directory, 'completed', `${job.id}.enc`), 'utf8');
  expect(bytes).not.toContain('secret source excerpt');
  expect(await readdir(join(store.directory, 'active'))).toEqual([]);
});

it('permits exactly one real process to take over a dead owner while retaining its new lease', async () => {
  const path = await root();
  const old = launch(path); expect(await old.result).toBe('owned');
  const died = new Promise<void>((resolve) => old.child.once('exit', () => resolve()));
  old.child.kill('SIGKILL'); await died;
  const first = launch(path), second = launch(path);
  const results = await Promise.all([first.result, second.result]);
  expect([...results].sort()).toEqual(['denied', 'owned']);
  const third = launch(path); expect(await third.result).toBe('denied');
  // Locate the owner from the durable lease instead of relying on race order.
  const namespace = (await readdir(path))[0]!;
  const lease = JSON.parse(await readFile(join(path, namespace, 'lease.json'), 'utf8')) as { pid: number };
  expect([first.child.pid, second.child.pid]).toContain(lease.pid);
  const owner = [first.child, second.child].find((child) => child.pid === lease.pid)!;
  const closed = new Promise<void>((resolve) => owner.once('exit', () => resolve()));
  owner.send('close'); await closed;
  const next = launch(path); expect(await next.result).toBe('owned');
});

const run: TranscriptRun = {
  id: 'codex:session', nativeId: 'session', source: 'codex', artifactId: `artifact-${'a'.repeat(64)}`,
  projectId: 'project-a', projectResolution: 'resolved', startedAt: '2026-09-15T10:00:00Z',
  counts: { records: 30, turns: 30, messages: 30, actions: 0, unknown: 0 }, segments: [],
};
const runEvent = makeTranscriptRunEvent({ author: { kind: 'ingest', id: 'importer' }, capture: { scope: { workspace: 'workspace' }, identity: { source: 'codex' } } }, { id: 'run-imported', t: 100, worldDate: '2026-09-15' }, run);
function trigger(id: string, kind = 'memory.recorded'): FoldEvent {
  return parseEvent({ specVersion: '0.7', id, kind, title: 'Trigger', at: { t: 100, worldDate: '2026-09-15', granularity: 'beat' }, author: { kind: 'human', id: 'user' }, participants: [], capture: { scope: { workspace: 'workspace' } }, changes: [{ verb: 'create', subject: 'trigger', nodeKind: 'fact', after: { label: 'trigger' }, provenance: { basis: 'authored' } }] });
}
function mockClient(events: FoldEvent[] = [runEvent], runs: TranscriptRun[] = [run]) {
  const client = {
    identity: vi.fn().mockResolvedValue({ principalId: 'worker-a', organizationId: 'org-a', workspaceId: 'workspace-a' }),
    eventById: vi.fn().mockImplementation(async (id: string) => events.find((event) => event.id === id)),
    transcriptRuns: vi.fn().mockResolvedValue(runs),
    transcriptRun: vi.fn().mockResolvedValue(undefined),
    listEvents: vi.fn().mockImplementation(async ({ kinds, eventIds }: { kinds?: string[]; eventIds?: string[] } = {}) =>
      events.filter((event) => (kinds === undefined || kinds.includes(event.kind)) && (eventIds === undefined || eventIds.includes(event.id))).map((event) => ({ event, status: 'canon' }))),
    memoryCandidates: vi.fn().mockResolvedValue([]),
    proposeMemoryCandidate: vi.fn(),
    ingestionConsumerStatus: vi.fn().mockResolvedValue({ cursor: null, legacyCursor: null, headCursor: { kind: 'ingestion', sequence: '0' }, migrationRequired: false }),
  };
  return client;
}
async function worker(client: ReturnType<typeof mockClient>, options: Partial<ConstructorParameters<typeof TranscriptMemoryWorker>[0]> = {}) {
  const path = await root();
  const instance = new TranscriptMemoryWorker({ client: client as unknown as SuperBrainClient, vaultRoot: join(path, 'vault'), stateRoot: join(path, 'jobs'), retryBaseMs: 1, pollIntervalMs: 1, ...options });
  return { instance, path };
}

describe('durable memory processing ledger', () => {
  it('uses canonical source digests regardless of JSON object key order', () => {
    expect(processingDigest({ a: 1, nested: { c: 3, b: 2 } })).toBe(processingDigest({ nested: { b: 2, c: 3 }, a: 1 }));
    expect(jobDigest({ a: 1, nested: { c: 3, b: 2 } })).toBe(jobDigest({ nested: { b: 2, c: 3 }, a: 1 }));
  });

  it('pages beyond the first 25 candidates, including an intra-message boundary', () => {
    const messages = [{ role: 'user' as const, turnId: 'turn', text: Array.from({ length: 33 }, (_, index) => `We decided that component ${index} must retain its canonical evidence permanently.`).join(' ') }];
    const first = extractMemoryCandidatePage(run, runEvent.id, messages);
    expect(first.candidates).toHaveLength(25);
    expect(first.next).toEqual({ message: 0, candidate: 25 });
    const last = extractMemoryCandidatePage(run, runEvent.id, messages, first.next);
    expect(last.candidates).toHaveLength(8);
    expect(last.candidates.at(-1)?.summary).toContain('component 32');
    expect(last.next).toBeUndefined();
  });

  it('applies backpressure before admitting new work, keeps replays idempotent, and requeues blocked work explicitly', async () => {
    const store = new DurableWorkerJobs(await root(), 'namespace', 1); stores.push(store); await store.open();
    const first = await store.enqueue('extract-run', 'first', { source: 1 }, 100);
    await expect(store.enqueue('extract-run', 'second', { source: 2 }, 101)).rejects.toBeInstanceOf(ProcessingBackpressureError);
    expect((await store.enqueue('extract-run', 'first', { source: 1 }, 102)).id).toBe(first.id);
    await store.put({ ...first, state: 'blocked', reason: 'operator-inspection', attempts: 4, updatedAt: 103 });
    expect(await store.coverage()).toMatchObject({ blocked: 1, pending: 0 });
    expect(await store.retryBlocked(200)).toBe(1);
    expect(await store.get(first.id)).toMatchObject({ state: 'pending', attempts: 0, nextAttemptAt: 200 });
    expect((await store.get(first.id))?.reason).toBeUndefined();
    await store.put({ ...(await store.get(first.id))!, state: 'completed', updatedAt: 201 });
    await expect(store.enqueue('extract-run', 'second', { source: 2 }, 202)).resolves.toMatchObject({ state: 'pending' });
  });

  it('persists encrypted scheduler checkpoints under the same lease', async () => {
    const path = await root();
    const store = new DurableWorkerJobs(path, 'namespace'); stores.push(store); await store.open();
    const id = processingDigest('policy');
    expect(await store.readSchedulerState(id)).toBeUndefined();
    await store.writeSchedulerState(id, { private: 'secret window source' });
    expect(await store.readSchedulerState(id)).toEqual({ private: 'secret window source' });
    expect(await store.schedulerStateIds()).toEqual([id]);
    const bytes = await readFile(join(store.directory, 'scheduler', `${id}.enc`), 'utf8');
    expect(bytes).not.toContain('secret window source');
    await expect(store.readSchedulerState('not-a-digest')).rejects.toThrow('Invalid scheduler identity');
  });

  it('persists before subscriber acknowledgment', async () => {
    const client = mockClient();
    const { instance } = await worker(client);
    const consumeEvents = vi.fn().mockImplementation(async ({ onEvent }) => {
      await onEvent({ entry: { event: runEvent, status: 'canon' }, cursor: { kind: 'ingestion', sequence: '1' } });
      expect((await instance.coverage()).byKind['extract-run']).toBe(1);
    });
    Object.assign(client, { consumeEvents });
    await instance.watch({ consumerId: 'test' });
    expect(consumeEvents).toHaveBeenCalledWith(expect.objectContaining({ consumerId: 'test', checkpointEvery: 100 }));
  });

  it('does not acknowledge a source when durable enqueue fails', async () => {
    const client = mockClient();
    let acknowledged = false;
    Object.assign(client, { consumeEvents: vi.fn().mockImplementation(async ({ onEvent }) => {
      await onEvent({ entry: { event: runEvent, status: 'canon' }, cursor: { kind: 'ingestion', sequence: '1' } });
      acknowledged = true;
    }) });
    const { instance } = await worker(client);
    const failing = vi.spyOn(DurableWorkerJobs.prototype, 'enqueue').mockRejectedValue(new Error('disk full'));
    try {
      await expect(instance.watch({ consumerId: 'test' })).rejects.toThrow('disk full');
      expect(acknowledged).toBe(false);
    } finally { failing.mockRestore(); }
  });

  it('pauses intake under backpressure without acknowledging, then resumes after capacity frees', async () => {
    const client = mockClient();
    const { instance } = await worker(client, { maxActiveJobs: 1, continuousCognition: true });
    await instance.scheduleEvent(runEvent); // Waits for its artifact metadata and keeps the only slot.
    let acknowledged = false;
    Object.assign(client, { consumeEvents: vi.fn().mockImplementation(async ({ onEvent }) => {
      const delivery = onEvent({ entry: { event: trigger('second-trigger'), status: 'canon' }, cursor: { kind: 'ingestion', sequence: '2' } }).then(() => { acknowledged = true; });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(acknowledged).toBe(false);
      const jobs = (instance as unknown as { store: DurableWorkerJobs }).store;
      const [active] = await jobs.active();
      await jobs.put({ ...active!, state: 'completed', updatedAt: 1 });
      await delivery;
      expect(acknowledged).toBe(true);
    }) });
    await instance.watch({ consumerId: 'test' });
    expect(acknowledged).toBe(true);
  });

  it.each([{ space: 'private-space' }, { creator: 'private-owner' }])('does not extract scoped transcript evidence into unscoped output: %s', async (scope) => {
    const privateEvent = { ...runEvent, capture: { ...runEvent.capture, scope: { workspace: 'workspace', ...scope } } };
    const client = mockClient([privateEvent]);
    const { instance } = await worker(client);
    expect(await instance.scheduleEvent(privateEvent)).toBe(0);
    expect((await instance.coverage()).byKind['extract-run']).toBe(0);
    expect(await instance.queueTranscriptBackfill(true)).toMatchObject({ counts: { unavailable: 1, queued: 0 } });
    await instance.close();
  });

  it('previews historical scheduling read-only, then queues the same durable job idempotently', async () => {
    const client = mockClient();
    const { instance, path } = await worker(client);
    expect(await instance.queueTranscriptBackfill()).toMatchObject({ mode: 'dry-run', counts: { eligible: 1, queued: 0 } });
    expect(await readdir(path)).toEqual([]);
    expect(await instance.queueTranscriptBackfill(true)).toMatchObject({ mode: 'queue', counts: { queued: 1 } });
    expect(await instance.scheduleEvent(runEvent)).toBe(0);
    expect(await instance.queueTranscriptBackfill(true)).toMatchObject({ counts: { existing: 1, queued: 0 } });
    expect((await instance.coverage()).byKind['extract-run']).toBe(1);
    expect(client.proposeMemoryCandidate).not.toHaveBeenCalled();
    await instance.close();
  });

  it('resumes a partially queued historical inventory after restart without duplicate jobs', async () => {
    const secondRun = { ...run, id: 'codex:second', nativeId: 'second', artifactId: `artifact-${'b'.repeat(64)}` };
    const secondEvent = makeTranscriptRunEvent({ author: { kind: 'ingest', id: 'importer' }, capture: runEvent.capture }, { id: 'second-import', t: 101, worldDate: '2026-09-15' }, secondRun);
    const client = mockClient([runEvent, secondEvent], [run, secondRun]);
    const { instance, path } = await worker(client);
    await instance.scheduleEvent(runEvent);
    await instance.close();
    const resumed = new TranscriptMemoryWorker({ client: client as unknown as SuperBrainClient, vaultRoot: join(path, 'vault'), stateRoot: join(path, 'jobs') });
    try {
      expect(await resumed.queueTranscriptBackfill(true)).toMatchObject({ counts: { queued: 1, existing: 1 } });
      expect((await resumed.coverage()).byKind['extract-run']).toBe(2);
      expect(client.proposeMemoryCandidate).not.toHaveBeenCalled();
    } finally { await resumed.close(); }
  });

  it('a pending model request does not block extraction in its independent lane', async () => {
    const client = mockClient([runEvent]);
    const { instance } = await worker(client, { continuousCognition: true, cognitionEveryEvents: 1 });
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    Object.assign(client, { reasoningProviders: vi.fn().mockImplementation(async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); return { providers: [] }; }) });
    await instance.scheduleEvent(trigger('cognition-trigger'));
    const slow = instance.drainModelJobs(); await started;
    await instance.scheduleEvent(runEvent);
    await instance.drainJobs();
    expect(client.transcriptRun).toHaveBeenCalled();
    expect((await instance.coverage()).waiting).toBe(1);
    release(); await slow;
    await instance.close();
  });
});
