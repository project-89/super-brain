import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local scheduler integration: 0 healthy, 1 actionable, 2 unavailable/unknown.
// No outbound notifications, request text, credentials or private paths emitted.
const readBounded = async (path, maximum) => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximum) throw new Error('Invalid local monitor input');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (result.bytesRead === 0) break; length += result.bytesRead; }
    const after = await handle.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error('Monitor input changed during read');
    return bytes.subarray(0, length).toString('utf8');
  } finally { await handle.close(); }
};
const alerts = [];
let unknown = false;
try {
  const config = JSON.parse(await readBounded(process.env.FOLD_OPERATIONS_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), '../deploy/monitoring.json'), 16_384));
  if (config.version !== 1 || ['requestTimeoutMs', 'maxCheckpointAgeMsWhenBehind', 'maxErrorsSinceStart', 'maxBackupAgeMs'].some((key) => !Number.isSafeInteger(config[key]) || config[key] < 1) || config.requestTimeoutMs > 30_000 || typeof config.requireConsumer !== 'boolean' || typeof config.requireVerifiedBackup !== 'boolean') throw new Error('Invalid monitor configuration');
  const base = new URL(process.env.FOLD_OPERATIONS_API_URL ?? '');
  if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) throw new Error('Monitor requires HTTPS or loopback HTTP');
  const organization = process.env.FOLD_OPERATIONS_ORGANIZATION;
  const workspace = process.env.FOLD_OPERATIONS_WORKSPACE;
  if (!organization || !workspace || !process.env.FOLD_OPERATIONS_TOKEN_FILE) throw new Error('Monitor configuration is incomplete');
  const token = (await readBounded(process.env.FOLD_OPERATIONS_TOKEN_FILE, 16_384)).trim();
  const url = `${base.toString().replace(/\/$/, '')}/v1/organizations/${encodeURIComponent(organization)}/workspaces/${encodeURIComponent(workspace)}/operations`;
  const response = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(config.requestTimeoutMs) });
  if (!response.ok) { unknown = true; alerts.push({ code: 'diagnostics_unavailable', status: response.status }); }
  else {
    const reader = response.body?.getReader(); if (!reader) throw new Error('Diagnostics body absent');
    const chunks = []; let bytes = 0;
    try { for (;;) { const item = await reader.read(); if (item.done) break; bytes += item.value.byteLength; if (bytes > 65_536) throw new Error('Diagnostics exceed bound'); chunks.push(item.value); } }
    finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const status = JSON.parse(Buffer.concat(chunks).toString());
    if (status.version !== 1) throw new Error('Unsupported diagnostics version');
    if (status.readiness?.status !== 'ready') alerts.push({ code: 'required_dependency_unavailable' });
    if (typeof status.errors !== 'number') { unknown = true; alerts.push({ code: 'error_count_unknown' }); }
    else if (status.errors >= config.maxErrorsSinceStart) alerts.push({ code: 'process_errors', countSinceStart: status.errors });
    const processing = status.processing;
    if (processing?.status !== 'observed') {
      if (config.requireConsumer) { unknown = true; alerts.push({ code: 'consumer_coverage_unknown' }); }
    } else {
      if (processing.unversionedConsumers > 0) alerts.push({ code: 'consumer_cursor_upgrade_required', count: processing.unversionedConsumers });
      if (!/^\d+$/.test(processing.largestCursorPositionGap)) throw new Error('Invalid consumer cursor summary');
      if (BigInt(processing.largestCursorPositionGap) > 0n && processing.oldestCheckpointAgeMs > config.maxCheckpointAgeMsWhenBehind) alerts.push({ code: 'consumer_checkpoint_behind', ageMs: Math.round(processing.oldestCheckpointAgeMs) });
    }
  }
  if (process.env.FOLD_OPERATIONS_BACKUP_RECEIPT) {
    const receipt = JSON.parse(await readBounded(process.env.FOLD_OPERATIONS_BACKUP_RECEIPT, 16_384));
    const ageMs = Date.now() - Date.parse(receipt.verifiedAt);
    if (receipt.version !== 1 || receipt.kind !== 'super-brain-recovery-verification' || receipt.integrity !== 'verified' || receipt.coverage !== 'complete-declared-topology' || !Number.isFinite(ageMs) || ageMs < 0 || !/^[a-f0-9]{64}$/.test(receipt.archiveSha256) || !/^[a-f0-9]{64}$/.test(receipt.manifestSha256)) { unknown = true; alerts.push({ code: 'backup_verification_unknown' }); }
    else if (ageMs > config.maxBackupAgeMs) alerts.push({ code: 'verified_backup_stale', ageMs: Math.round(ageMs), destination: receipt.destination === 'transferred' ? 'transferred' : 'local' });
  } else if (config.requireVerifiedBackup) { unknown = true; alerts.push({ code: 'backup_verification_unknown' }); }
} catch { unknown = true; alerts.push({ code: 'monitor_input_or_dependency_unavailable' }); }
const status = unknown ? 'unknown' : alerts.length > 0 ? 'action-required' : 'healthy';
console.log(JSON.stringify({ version: 1, status, observedAt: new Date().toISOString(), alerts }, null, 2));
process.exitCode = unknown ? 2 : alerts.length > 0 ? 1 : 0;
