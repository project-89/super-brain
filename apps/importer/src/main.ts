#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";

import { deliverTranscriptBundle, listDeliveredTranscriptRunIds } from "./delivery.js";
import { storeRedactedArtifact } from "./redact.js";
import { scanTranscripts } from "./scan.js";

const args = process.argv.slice(2).filter((argument) => argument !== "--");

function option(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} requires a value`);
  }
  return value;
}

function hasFlag(name: string): boolean {
  return args.includes(name);
}

function sourceRoots(source: string | undefined) {
  const claude = option("--claude-root") ?? join(homedir(), ".claude", "projects");
  const codex = option("--codex-root") ?? join(homedir(), ".codex", "sessions");
  if (source === "claude") return { claude };
  if (source === "codex") return { codex };
  if (source === undefined || source === "all") return { claude, codex };
  throw new TypeError("--source must be claude, codex, or all");
}

async function main(): Promise<void> {
  const command = args[0] ?? "scan";
  if (command !== "scan" && command !== "import") {
    throw new TypeError("supported commands: scan, import");
  }
  let delivery: {
    readonly apiUrl: string;
    readonly workspaceId: string;
    readonly bearerToken: string;
    readonly vaultRoot: string;
  } | undefined;
  if (command === "import") {
    if (!hasFlag("--confirm")) {
      throw new TypeError("import requires --confirm; run scan first to review the inventory");
    }
    if (args.includes("--token")) {
      throw new TypeError("use FOLD_API_TOKEN instead of a command-line token");
    }
    const apiUrl = option("--api-url") ?? process.env.FOLD_API_URL;
    const workspaceId = option("--workspace") ?? process.env.FOLD_API_WORKSPACE;
    const bearerToken = process.env.FOLD_API_TOKEN;
    const vaultRoot = option("--vault") ?? process.env.FOLD_TRANSCRIPT_VAULT;
    if (apiUrl === undefined) throw new TypeError("import requires --api-url or FOLD_API_URL");
    if (workspaceId === undefined) throw new TypeError("import requires --workspace or FOLD_API_WORKSPACE");
    if (bearerToken === undefined) throw new TypeError("import requires FOLD_API_TOKEN");
    if (vaultRoot === undefined) throw new TypeError("import requires --vault or FOLD_TRANSCRIPT_VAULT");
    delivery = { apiUrl, workspaceId, bearerToken, vaultRoot };
  }
  const limitValue = option("--limit");
  const limit = limitValue === undefined ? undefined : Number(limitValue);
  const report = await scanTranscripts({
    roots: sourceRoots(option("--source")),
    ...(limit === undefined ? {} : { limit }),
  });
  const baseSummary = {
    discoveredFiles: report.discoveredFiles,
    parsedRuns: report.parsedFiles,
    totalBytes: report.totalBytes,
    projects: report.projects,
    turns: report.turns,
    actions: report.actions,
    unknownRecords: report.unknownRecords,
    bySource: report.bySource,
    failures: report.failures,
  };
  if (command === "scan") {
    process.stdout.write(`${JSON.stringify({ mode: "dry-run", ...baseSummary }, null, 2)}\n`);
    return;
  }

  if (delivery === undefined) throw new TypeError("transcript delivery configuration is unavailable");

  const deliveredRunIds = hasFlag("--resume")
    ? await listDeliveredTranscriptRunIds({
        apiUrl: delivery.apiUrl,
        workspaceId: delivery.workspaceId,
        bearerToken: delivery.bearerToken,
      })
    : new Set<string>();

  const results: Array<{
    readonly runId: string;
    readonly source: string;
    readonly imported?: boolean;
    readonly eventCount?: number;
    readonly error?: string;
  }> = [];
  for (const transcript of report.transcripts) {
    if (deliveredRunIds.has(transcript.bundle.run.id)) {
      results.push({
        runId: transcript.bundle.run.id,
        source: transcript.bundle.run.source,
        imported: false,
        eventCount: 0,
      });
      continue;
    }
    try {
      const stored = await storeRedactedArtifact(transcript, delivery.vaultRoot);
      const delivered = await deliverTranscriptBundle(stored.bundle, {
        apiUrl: delivery.apiUrl,
        workspaceId: delivery.workspaceId,
        bearerToken: delivery.bearerToken,
      });
      results.push({
        runId: delivered.run.id,
        source: delivered.run.source,
        imported: delivered.imported,
        eventCount: delivered.eventCount,
      });
    } catch (error) {
      results.push({
        runId: transcript.bundle.run.id,
        source: transcript.bundle.run.source,
        error: error instanceof Error ? error.message : "Unknown import error",
      });
    }
  }
  const deliveryFailures = results.filter((result) => result.error !== undefined).length;
  process.stdout.write(`${JSON.stringify({
    mode: "import",
    ...baseSummary,
    deliveredRuns: results.length - deliveryFailures,
    newRuns: results.filter((result) => result.imported === true).length,
    unchangedRuns: results.filter((result) => result.imported === false).length,
    resumedRuns: deliveredRunIds.size,
    deliveryFailures,
    results,
  }, null, 2)}\n`);
  if (deliveryFailures > 0) process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
