import { mkdtemp, writeFile, chmod, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readProcessingStatus } from "../src/processing-status.js";

const now = Date.now();
const payload = { version: 1, status: "running", observedAt: new Date(now).toISOString(), subject: { organizationId: "org", workspaceId: "workspace", principalId: "worker" }, coverage: { pending: 1, waiting: 2, retry: 3, completed: 4, excluded: 5, exhausted: 6, byKind: { "extract-run": 1 }, oldestPendingAt: now - 100 }, lagMs: 100 };
describe("private processing status", () => {
  it("returns only fresh sanitized owner-only aggregate data", async () => {
    const root = await mkdtemp(join(tmpdir(), "processing-bridge-")); const path = join(root, "status.json"); const config = { organizationId: "org", workspaceId: "workspace", processingStatusFile: path };
    try {
      await writeFile(path, JSON.stringify({ ...payload, token: "private-key", jobs: [{ path: "/private" }], coverage: { ...payload.coverage, byKind: { ...payload.coverage.byKind, "private-job-path": 100 } } }), { mode: 0o600 });
      const result = await readProcessingStatus(config, now); expect(result).toMatchObject({ available: true, coverage: { pending: 1, byKind: { "extract-run": 1 } } }); expect(JSON.stringify(result)).not.toMatch(/private-key|private-job-path|\/private/);
      expect(await readProcessingStatus(config, now + 60_001)).toMatchObject({ available: false, reason: "stale" });
      expect(await readProcessingStatus({ ...config, workspaceId: "other" }, now)).toMatchObject({ available: false, reason: "wrong-workspace" });
      await writeFile(path, JSON.stringify({ ...payload, status: "stopped" })); expect(await readProcessingStatus(config, now)).toMatchObject({ available: false, reason: "stopped" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("fails closed for missing, oversized, public, symlinked and malformed publication files", async () => {
    const root = await mkdtemp(join(tmpdir(), "processing-bridge-")); const path = join(root, "status.json"); const config = { organizationId: "org", workspaceId: "workspace", processingStatusFile: path };
    try {
      expect(await readProcessingStatus(config, now)).toMatchObject({ available: false });
      await writeFile(path, JSON.stringify(payload), { mode: 0o644 }); expect(await readProcessingStatus(config, now)).toMatchObject({ available: false });
      await chmod(path, 0o600); const alias = join(root, "alias"); await symlink(path, alias); expect(await readProcessingStatus({ ...config, processingStatusFile: alias }, now)).toMatchObject({ available: false });
      await writeFile(path, " ".repeat(65 * 1024)); expect(await readProcessingStatus(config, now)).toMatchObject({ available: false });
      await writeFile(path, JSON.stringify({ ...payload, coverage: { ...payload.coverage, pending: -1 } })); expect(await readProcessingStatus(config, now)).toMatchObject({ available: false });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
