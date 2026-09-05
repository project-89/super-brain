#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";

import { deliverTranscriptBundle, listDeliveredTranscriptRunIds, readDeliveredTranscriptBundle } from "./delivery.js";
import { reinterpretStoredTranscript } from "./reinterpret.js";
import { storeRedactedArtifact } from "./redact.js";
import { ensureVaultKey, readVaultKey } from "./encryption.js";
import { RecordAnonymizer, type AnonymizationPolicy } from "./privacy.js";
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
  if (command === "reinterpret") {
    if (args.includes("--token")) throw new TypeError("use FOLD_API_TOKEN instead of a command-line token");
    const apiUrl = option("--api-url") ?? process.env.FOLD_API_URL;
    const organizationId = option("--organization") ?? process.env.FOLD_API_ORGANIZATION ?? "local";
    const workspaceId = option("--workspace") ?? process.env.FOLD_API_WORKSPACE;
    const bearerToken = process.env.FOLD_API_TOKEN;
    const vaultRoot = option("--vault") ?? process.env.FOLD_TRANSCRIPT_VAULT;
    const runId = option("--run");
    const parserVersion = option("--parser-version");
    if (!apiUrl || !workspaceId || !bearerToken || !vaultRoot || !runId) throw new TypeError("reinterpret requires API URL, workspace, token environment variable, vault and explicit --run");
    if (parserVersion !== "2") throw new TypeError("reinterpret requires explicit --parser-version 2");
    const keyPath = option("--vault-key") ?? process.env.FOLD_TRANSCRIPT_VAULT_KEY_FILE;
    const delivery = { apiUrl, organizationId, workspaceId, bearerToken };
    const previous = await readDeliveredTranscriptBundle(runId, delivery);
    const result = await reinterpretStoredTranscript(previous, { vaultRoot, parserVersion,
      ...(keyPath === undefined ? {} : { encryptionKey: await readVaultKey(keyPath) }) });
    const imported = hasFlag("--confirm") && result.report.recomputed ? await deliverTranscriptBundle(result.bundle, delivery) : undefined;
    process.stdout.write(`${JSON.stringify({ mode: hasFlag("--confirm") ? "reinterpret" : "reinterpret-preview", ...result.report,
      ...(imported === undefined ? {} : { imported: imported.imported, eventCount: imported.eventCount }) }, null, 2)}\n`);
    return;
  }
  if (command !== "scan" && command !== "import") {
    throw new TypeError("supported commands: scan, import, reinterpret");
  }
  let delivery: {
    readonly apiUrl: string;
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly bearerToken: string;
    readonly vaultRoot: string;
    readonly vaultEncryptionKey?: Uint8Array;
    readonly reasoningPolicy: "exclude" | "include";
    readonly retainEncryptedReasoning: boolean;
    readonly anonymizer: RecordAnonymizer;
  } | undefined;
  if (command === "import") {
    if (!hasFlag("--confirm")) {
      throw new TypeError("import requires --confirm; run scan first to review the inventory");
    }
    if (args.includes("--token")) {
      throw new TypeError("use FOLD_API_TOKEN instead of a command-line token");
    }
    const apiUrl = option("--api-url") ?? process.env.FOLD_API_URL;
    const organizationId = option("--organization") ?? process.env.FOLD_API_ORGANIZATION ?? "local";
    const workspaceId = option("--workspace") ?? process.env.FOLD_API_WORKSPACE;
    const bearerToken = process.env.FOLD_API_TOKEN;
    const vaultRoot = option("--vault") ?? process.env.FOLD_TRANSCRIPT_VAULT;
    const vaultKeyPath = option("--vault-key") ?? process.env.FOLD_TRANSCRIPT_VAULT_KEY_FILE;
    const reasoningPolicy = option("--reasoning") ?? "exclude";
    if (reasoningPolicy !== "exclude" && reasoningPolicy !== "include") {
      throw new TypeError("--reasoning must be exclude or include");
    }
    const encryptedReasoning = option("--encrypted-reasoning") ?? "exclude";
    if (encryptedReasoning !== "exclude" && encryptedReasoning !== "retain") {
      throw new TypeError("--encrypted-reasoning must be exclude or retain");
    }
    const anonymizationPolicy = (option("--anonymize") ?? "none") as AnonymizationPolicy;
    if (!["none", "pseudonymous", "strict"].includes(anonymizationPolicy)) {
      throw new TypeError("--anonymize must be none, pseudonymous, or strict");
    }
    const anonymizationKeyPath = option("--anonymization-key") ?? process.env.FOLD_ANONYMIZATION_KEY_FILE;
    if (anonymizationPolicy !== "none" && anonymizationKeyPath === undefined) {
      throw new TypeError("pseudonymous and strict imports require --anonymization-key or FOLD_ANONYMIZATION_KEY_FILE");
    }
    if (apiUrl === undefined) throw new TypeError("import requires --api-url or FOLD_API_URL");
    if (workspaceId === undefined) throw new TypeError("import requires --workspace or FOLD_API_WORKSPACE");
    if (bearerToken === undefined) throw new TypeError("import requires FOLD_API_TOKEN");
    if (vaultRoot === undefined) throw new TypeError("import requires --vault or FOLD_TRANSCRIPT_VAULT");
    const anonymizationKey = anonymizationKeyPath === undefined
      ? undefined
      : await ensureVaultKey(anonymizationKeyPath).then(() => readVaultKey(anonymizationKeyPath));
    delivery = {
      apiUrl,
      organizationId,
      workspaceId,
      bearerToken,
      vaultRoot,
      ...(vaultKeyPath === undefined ? {} : { vaultEncryptionKey: await readVaultKey(vaultKeyPath) }),
      reasoningPolicy,
      retainEncryptedReasoning: reasoningPolicy === "include" && encryptedReasoning === "retain",
      anonymizer: new RecordAnonymizer(anonymizationPolicy, anonymizationKey),
    };
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
        organizationId: delivery.organizationId,
        workspaceId: delivery.workspaceId,
        bearerToken: delivery.bearerToken,
      })
    : new Set<string>();

  const results: Array<{
    readonly runId: string;
    readonly source: string;
    readonly imported?: boolean;
    readonly eventCount?: number;
    readonly interpretation?: "retained-existing";
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
      const stored = await storeRedactedArtifact(transcript, delivery.vaultRoot, {
        reasoningPolicy: delivery.reasoningPolicy,
        retainEncryptedReasoning: delivery.retainEncryptedReasoning,
        anonymizer: delivery.anonymizer,
        ...(delivery.vaultEncryptionKey === undefined ? {} : { encryptionKey: delivery.vaultEncryptionKey }),
      });
      const delivered = await deliverTranscriptBundle(stored.bundle, {
        apiUrl: delivery.apiUrl,
        organizationId: delivery.organizationId,
        workspaceId: delivery.workspaceId,
        bearerToken: delivery.bearerToken,
      });
      results.push({
        runId: delivered.run.id,
        source: delivered.run.source,
        imported: delivered.imported,
        eventCount: delivered.eventCount,
        ...(delivered.interpretation === undefined ? {} : { interpretation: delivered.interpretation }),
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
