import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/fold-postgres/package.json'));
const { Pool } = require('pg');
const project = `fold-smoke-${randomUUID().slice(0, 8)}`;
const state = join(root, '.data/deployment', project);
await mkdir(state, { recursive: true, mode: 0o700 });
// The enclosing directory is owner-only. Compose file secrets bind the leaf's
// mode unchanged; read-only leaf permissions let nonroot containers read it.
const secret = async (name, value) => writeFile(join(state, name), value, { mode: 0o444, flag: 'wx' });
const freePort = async () => {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};
const [httpsPort, apiAPort, apiBPort, databasePort] = await Promise.all(Array.from({ length: 4 }, freePort));
const passwords = Object.fromEntries(['admin', 'migration', 'runtime', 'recovery'].map((kind) => [kind, randomUUID()]));
for (const [kind, value] of Object.entries(passwords)) await secret(kind === 'admin' ? 'database-admin-password' : `${kind}-password`, value);
for (const kind of ['migration', 'runtime']) await secret(`${kind}-database-url`, `postgres://fold_${kind === 'migration' ? 'migrator' : kind}:${passwords[kind]}@database:5432/super_brain`);
const token = randomUUID(); const rotatedToken = randomUUID(); const otherToken = randomUUID();
const membership = (principalId, organizationId) => ({ principalId, author: { kind: 'human', id: principalId },
  capabilities: ['events:read', 'events:write', 'memories:read', 'memories:write', 'consumers:read', 'consumers:write', 'operations:read'],
  organizations: { [organizationId]: { role: 'owner', workspaces: { workspace: { role: 'owner', spaces: { 'space-a': 'writer' } } } } } });
await secret('api-credentials.json', JSON.stringify({ [token]: membership('pilot-user', 'pilot-org'), [rotatedToken]: membership('pilot-user', 'pilot-org'), [otherToken]: membership('other-user', 'other-org') }));
const override = join(state, 'compose-smoke.yaml');
await secret('compose-smoke.yaml', `services:\n  api-a:\n    ports: ["127.0.0.1:${apiAPort}:3000"]\n  api-b:\n    ports: ["127.0.0.1:${apiBPort}:3000"]\n  database:\n    ports: ["127.0.0.1:${databasePort}:5432"]\n`);
const env = { ...process.env, FOLD_DEPLOY_SECRETS_DIR: state, FOLD_HTTPS_PORT: String(httpsPort), FOLD_PUBLIC_HOST: 'localhost' };
delete env.FOLD_DATABASE_URL;
const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  const chunks = []; let size = 0;
  const collect = (chunk) => { size += chunk.length; if (size <= 2_000_000) chunks.push(chunk); };
  child.stdout?.on('data', collect); child.stderr?.on('data', collect);
  child.once('error', reject);
  child.once('close', (code) => code === 0 ? resolve(Buffer.concat(chunks).toString()) : reject(new Error(`${command} ${args[0]} failed (${code}); private drill log retained`)));
});
const compose = (...args) => run('docker', ['compose', '--project-name', project, '-f', 'deploy/compose.yaml', '-f', override, ...args]);
const apiA = `http://127.0.0.1:${apiAPort}`; const apiB = `http://127.0.0.1:${apiBPort}`;
const route = '/v1/organizations/pilot-org/workspaces/workspace';
const http = async (base, path, { bearer = token, method = 'GET', body } = {}) => {
  const response = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(8_000) });
  return { status: response.status, body: await response.json() };
};
const waitReady = async (base, status = 200) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { if ((await http(base, '/ready')).status === status) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Readiness did not reach expected status ${status}`);
};
const report = { version: 1, kind: 'synthetic-deployment-smoke', checks: [], startedAt: new Date().toISOString() };
let admin; let runtime;
try {
  if (process.env.FOLD_SMOKE_SKIP_BUILD !== 'true') await compose('build', 'api-a', 'proxy');
  await compose('up', '-d', 'database');
  await compose('run', '--rm', 'migrate');
  await compose('--profile', 'bootstrap', 'run', '--rm', 'bootstrap');
  await compose('up', '-d', 'api-a', 'api-b', 'proxy');
  await Promise.all([waitReady(apiA), waitReady(apiB)]);
  report.checks.push('two-runtime-processes-ready');
  for (const service of ['api-a', 'api-b']) {
    const id = (await compose('ps', '-q', service)).trim();
    const details = JSON.parse(await run('docker', ['inspect', id]))[0];
    const names = details.Config.Env.map((value) => value.slice(0, value.indexOf('=')));
    assert.ok(!names.some((name) => /MIGRATION|RECOVERY|ADMIN_PASSWORD|DATABASE_URL$|API_CREDENTIALS_JSON$/.test(name)));
    const mountedSecrets = details.Mounts.filter((mount) => mount.Destination.startsWith('/run/secrets/')).map((mount) => mount.Destination).sort();
    assert.deepEqual(mountedSecrets, ['/run/secrets/api_credentials', '/run/secrets/runtime_database_url']);
    assert.equal(details.Config.User, 'node');
  }
  report.checks.push('nonroot-runtime-secret-separation');
  admin = new Pool({ connectionString: `postgres://postgres:${passwords.admin}@127.0.0.1:${databasePort}/super_brain`, connectionTimeoutMillis: 2_000 });
  runtime = new Pool({ connectionString: `postgres://fold_runtime:${passwords.runtime}@127.0.0.1:${databasePort}/super_brain`, connectionTimeoutMillis: 2_000 });
  for (const sql of ['ALTER TABLE fold.fold_events DISABLE ROW LEVEL SECURITY', 'ALTER TABLE fold.fold_workspace_memberships ADD COLUMN bad text', 'UPDATE fold.fold_schema_versions SET version=999', 'SET ROLE fold_migrator']) {
    await assert.rejects(runtime.query(sql), { code: '42501' });
  }
  report.checks.push('runtime-role-cannot-alter-or-bypass');
  const command = { stamp: { id: randomUUID(), t: 200, worldDate: '2026-09-05' }, input: { id: randomUUID(), source: 'deployment-fixture', applicability: { kind: 'global' }, content: { decision: 'synthetic-only' }, tags: [] } };
  const accepted = await http(apiA, `${route}/memories`, { method: 'POST', body: command });
  assert.equal(accepted.status, 201);
  const retried = await http(apiB, `${route}/memories`, { method: 'POST', body: command });
  assert.equal(retried.status, 201); assert.deepEqual(retried.body, accepted.body);
  report.checks.push('exact-command-retry-through-other-process');
  const event = (id, t) => ({ specVersion: '0.7', id, kind: 'deployment.observed', title: id, at: { t, worldDate: '2026-09-05' }, author: { kind: 'human', id: 'pilot-user' },
    capture: { scope: { organization: 'pilot-org', workspace: 'workspace' }, identity: { principal: 'pilot-user', workspace: 'workspace' } },
    changes: [{ verb: 'create', subject: `urn:smoke:${id}`, nodeKind: 'fact', after: { observed: true }, provenance: { basis: 'authored' } }] });
  assert.equal((await http(apiA, `${route}/events`, { method: 'POST', body: { event: event('first', 100), status: 'canon' } })).status, 201);
  assert.equal((await http(apiB, `${route}/events`, { method: 'POST', body: { event: event('late', 1), status: 'canon' } })).status, 201);
  const read = await http(apiB, `${route}/events`);
  assert.equal(read.status, 200); assert.match(JSON.stringify(read.body), /first/); assert.match(JSON.stringify(read.body), /late/);
  assert.equal((await http(apiB, `${route}/events`, { bearer: otherToken })).status, 403);
  const other = await http(apiB, '/v1/organizations/other-org/workspaces/workspace/events', { bearer: otherToken });
  assert.equal(other.status, 200); assert.doesNotMatch(JSON.stringify(other.body), /first|late/);
  report.checks.push('cross-process-write-and-late-delivery', 'tenant-isolation');
  const proxyId = (await compose('ps', '-q', 'proxy')).trim();
  const caPath = join(state, 'proxy-root.crt');
  await run('docker', ['cp', `${proxyId}:/data/caddy/pki/authorities/local/root.crt`, caPath]);
  const ca = await readFile(caPath);
  const secureRead = (path, bearer) => new Promise((resolve, reject) => {
    const request = httpsRequest({ hostname: 'localhost', port: httpsPort, path, ca, headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }, timeout: 8_000 }, (response) => {
      const chunks = []; response.on('data', (chunk) => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString() }));
    });
    request.once('timeout', () => request.destroy(new Error('TLS request timed out'))); request.once('error', reject); request.end();
  });
  const brain = await secureRead('/'); assert.equal(brain.status, 200); assert.match(brain.text, /<div id="root"/);
  const asset = brain.text.match(/src="([^"]+\.js)"/); assert.ok(asset);
  assert.match((await secureRead(asset[1])).text, /\/api/);
  assert.equal((await secureRead(`/api${route}/events`, token)).status, 200);
  report.checks.push('verified-local-ca-tls', 'hosted-brain-same-origin-api');
  await admin.query("DELETE FROM fold.fold_workspace_memberships WHERE organization_id='pilot-org' AND principal_id='pilot-user'");
  assert.equal((await http(apiA, `${route}/events`)).status, 403);
  await compose('restart', 'api-a', 'api-b');
  await Promise.all([waitReady(apiA), waitReady(apiB)]);
  assert.equal((await http(apiA, `${route}/events`)).status, 403);
  assert.equal((await http(apiB, `${route}/events`, { bearer: rotatedToken })).status, 403);
  report.checks.push('revocation-survives-both-restarts-and-token-rotation');
  await runtime.end(); runtime = undefined; await admin.end(); admin = undefined;
  await compose('stop', 'database');
  await Promise.all([waitReady(apiA, 503), waitReady(apiB, 503)]);
  assert.equal((await http(apiA, '/health')).status, 200);
  await compose('start', 'database'); await Promise.all([waitReady(apiA), waitReady(apiB)]);
  report.checks.push('bounded-readiness-outage-and-recovery');
  report.status = 'passed'; report.completedAt = new Date().toISOString();
  await writeFile(join(state, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await runtime?.end(); await admin?.end();
  await compose('down', '--volumes', '--remove-orphans').catch(() => undefined);
}
