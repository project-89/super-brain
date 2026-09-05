import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { DurableWorkerJobs } from '../src/jobs.js';

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
