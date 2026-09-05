import { DurableWorkerJobs } from '../../dist/index.js';
const jobs = new DurableWorkerJobs(process.argv[2], 'lease-concurrency-fixture');
try {
  await jobs.open();
  process.send?.({ status: 'owned' });
  process.on('message', async (message) => {
    if (message === 'close') { await jobs.close(); process.exit(0); }
  });
} catch {
  process.send?.({ status: 'denied' });
  process.exitCode = 2;
  process.disconnect?.();
}
