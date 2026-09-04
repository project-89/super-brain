#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CaptureEngine } from "./capture.js";
import {
  defaultConfigPath,
  enableCaptureVaultEncryption,
  initializeCaptureConfig,
  readCaptureConfig,
  rotateCaptureOperatorToken,
  updateCaptureConfig,
} from "./config.js";
import { SpoolProcessor } from "./delivery.js";
import { installHermesHook, installHooks, installLaunchAgent } from "./install.js";
import { CaptureHttpServer } from "./server.js";
import { readExposedReasoningDelta } from "./reasoning.js";
import { exportCaptureData, pruneHookArtifacts, verifyCaptureExport } from "./maintenance.js";
import { DurableSpool, HookVault, recordRelayFailure, StateStore } from "./storage.js";
import type { HookSource, ReasoningPolicy, ReasoningTreePolicy } from "./types.js";
import { readVaultKey, RecordAnonymizer, type AnonymizationPolicy } from "@_89/super-brain-importer";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function configPath(args: readonly string[]): string {
  return resolve(option(args, "--config") ?? defaultConfigPath());
}

async function stdin(limit = 2 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) throw new Error("hook payload exceeds 2 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function executablePath(): string {
  return resolve(fileURLToPath(import.meta.url));
}

async function relay(args: readonly string[], path = "/hook"): Promise<void> {
  const source = args[1] as HookSource | undefined;
  if (source === undefined) return;
  try {
    const config = await readCaptureConfig(configPath(args));
    const raw = await stdin();
    const body = path === "/hook"
      ? raw.trim().length === 0 ? "{}" : raw
      : JSON.stringify({
          ...(raw.trim().length === 0 ? {} : JSON.parse(raw) as Record<string, unknown>),
          source,
        });
    const response = await fetch(`http://${config.bindHost}:${config.port}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agent-source": source,
        "x-super-brain-hook-token": config.hookToken,
      },
      body,
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`capture daemon rejected the request with HTTP ${response.status}`);
  } catch (error) {
    if (path !== "/hook") throw error;
    // Lifecycle hooks must never block or break the coding-agent host.
    try {
      const config = await readCaptureConfig(configPath(args));
      await recordRelayFailure(config.stateRoot, source, path, error);
    } catch {
      // Capture diagnostics must not break the host either.
    }
  }
}

async function run(args: readonly string[]): Promise<void> {
  const path = configPath(args);
  const config = await readCaptureConfig(path);
  const vaultEncryptionKey = config.vaultKeyPath === undefined ? undefined : await readVaultKey(config.vaultKeyPath);
  const anonymizationKey = config.anonymizationPolicy === "none"
    ? undefined
    : await readVaultKey(config.anonymizationKeyPath!);
  const anonymizer = new RecordAnonymizer(config.anonymizationPolicy, anonymizationKey);
  const spool = new DurableSpool(config.stateRoot);
  const engine = new CaptureEngine(
    config,
    new StateStore(config.stateRoot),
    new HookVault(config.vaultRoot, vaultEncryptionKey, {
      anonymizer,
      retainEncryptedReasoning: config.reasoningPolicy === "include" && config.retainEncryptedReasoning,
    }),
    spool,
    anonymizer,
  );
  await engine.initialize();
  const processor = new SpoolProcessor(config, spool, vaultEncryptionKey, anonymizer);
  const server = new CaptureHttpServer(config, engine, spool, async (patch) => {
    if (
      patch.anonymizationPolicy !== undefined &&
      patch.anonymizationPolicy !== config.anonymizationPolicy &&
      engine.snapshot().unfinishedSessions > 0
    ) {
      throw new Error("anonymization policy cannot change while sessions are unfinished");
    }
    const result = await updateCaptureConfig(path, patch);
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 100).unref();
    return result.config;
  }, vaultEncryptionKey);
  await server.start();
  processor.start();
  const heartbeats = setInterval(() => void engine.heartbeat().catch(() => undefined), config.heartbeatIntervalMs);
  process.stdout.write(`Super Brain capture listening on http://${config.bindHost}:${config.port}\n`);
  await new Promise<void>((resolvePromise) => {
    const stop = () => resolvePromise();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  clearInterval(heartbeats);
  await server.close();
  await processor.stop();
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const command = args[0] ?? "help";
  if (command === "relay") {
    await relay(args);
    return;
  }
  if (command === "checkpoint") {
    await relay(args, "/checkpoint");
    return;
  }
  if (command === "decision") {
    await relay(args, "/decision");
    return;
  }
  if (command === "run") {
    await run(args);
    return;
  }
  if (command === "init") {
    const apiToken = process.env.SUPER_BRAIN_CAPTURE_TOKEN;
    if (apiToken === undefined || apiToken.trim().length === 0) {
      throw new Error("SUPER_BRAIN_CAPTURE_TOKEN is required for init");
    }
    const reasoning = option(args, "--reasoning") as ReasoningPolicy | undefined;
    const reasoningTrees = option(args, "--reasoning-trees") as ReasoningTreePolicy | undefined;
    const anonymization = option(args, "--anonymize") as AnonymizationPolicy | undefined;
    const treeEvery = option(args, "--tree-every");
    const result = await initializeCaptureConfig({
      path: configPath(args),
      apiToken,
      ...(option(args, "--api-url") === undefined ? {} : { apiUrl: option(args, "--api-url")! }),
      ...(option(args, "--organization") === undefined ? {} : { organizationId: option(args, "--organization")! }),
      ...(option(args, "--workspace") === undefined ? {} : { workspaceId: option(args, "--workspace")! }),
      ...(option(args, "--state-root") === undefined ? {} : { stateRoot: option(args, "--state-root")! }),
      ...(option(args, "--vault") === undefined ? {} : { vaultRoot: option(args, "--vault")! }),
      ...(option(args, "--vault-key") === undefined ? {} : { vaultKeyPath: option(args, "--vault-key")! }),
      ...(reasoning === undefined ? {} : { reasoningPolicy: reasoning }),
      ...(option(args, "--encrypted-reasoning") === undefined
        ? {}
        : { retainEncryptedReasoning: option(args, "--encrypted-reasoning") === "retain" }),
      ...(reasoningTrees === undefined ? {} : { reasoningTreePolicy: reasoningTrees }),
      ...(treeEvery === undefined ? {} : { treeSnapshotEveryEvents: Number(treeEvery) }),
      ...(anonymization === undefined ? {} : { anonymizationPolicy: anonymization }),
      ...(option(args, "--anonymization-key") === undefined
        ? {}
        : { anonymizationKeyPath: option(args, "--anonymization-key")! }),
      force: args.includes("--force"),
    });
    process.stdout.write(`Created ${result.path}\n`);
    return;
  }
  if (command === "install-hooks") {
    const paths = await installHooks(executablePath(), configPath(args));
    process.stdout.write(`${paths.join("\n")}\n`);
    return;
  }
  if (command === "install-service") {
    process.stdout.write(`${await installLaunchAgent(executablePath(), configPath(args))}\n`);
    return;
  }
  if (command === "install-hermes-hook") {
    process.stdout.write(`${(await installHermesHook(configPath(args))).join("\n")}\n`);
    return;
  }
  if (command === "enable-vault-encryption") {
    const result = await enableCaptureVaultEncryption(configPath(args), option(args, "--vault-key"));
    process.stdout.write(`Enabled encrypted vault writes using ${result.keyPath}\n`);
    return;
  }
  if (command === "configure") {
    const current = await readCaptureConfig(configPath(args));
    const reasoning = option(args, "--reasoning") as ReasoningPolicy | undefined;
    const reasoningTrees = option(args, "--reasoning-trees") as ReasoningTreePolicy | undefined;
    const anonymization = option(args, "--anonymize") as AnonymizationPolicy | undefined;
    const encryptedReasoning = option(args, "--encrypted-reasoning");
    if (encryptedReasoning !== undefined && encryptedReasoning !== "retain" && encryptedReasoning !== "exclude") {
      throw new TypeError("--encrypted-reasoning must be retain or exclude");
    }
    const treeEvery = option(args, "--tree-every");
    if (anonymization !== undefined && anonymization !== current.anonymizationPolicy) {
      const state = await new StateStore(current.stateRoot).load();
      if (Object.values(state.sessions).some((session) => !session.finalized)) {
        throw new Error("anonymization policy cannot change while sessions are unfinished");
      }
    }
    const result = await updateCaptureConfig(configPath(args), {
      ...(reasoning === undefined ? {} : { reasoningPolicy: reasoning }),
      ...(encryptedReasoning === undefined ? {} : { retainEncryptedReasoning: encryptedReasoning === "retain" }),
      ...(reasoningTrees === undefined
        ? reasoning === "exclude" ? { reasoningTreePolicy: "exclude" } : {}
        : { reasoningTreePolicy: reasoningTrees }),
      ...(treeEvery === undefined ? {} : { treeSnapshotEveryEvents: Number(treeEvery) }),
      ...(anonymization === undefined ? {} : { anonymizationPolicy: anonymization }),
      ...(option(args, "--anonymization-key") === undefined
        ? {}
        : { anonymizationKeyPath: option(args, "--anonymization-key")! }),
    });
    const safe = { ...result.config, apiToken: "[REDACTED]", hookToken: "[REDACTED]", operatorToken: "[REDACTED]" };
    process.stdout.write(`${JSON.stringify({ path: result.path, restartRequired: true, previous: {
      reasoningPolicy: current.reasoningPolicy,
      anonymizationPolicy: current.anonymizationPolicy,
    }, config: safe }, null, 2)}\n`);
    return;
  }
  if (command === "rotate-operator-token") {
    const result = await rotateCaptureOperatorToken(configPath(args));
    process.stdout.write(`${JSON.stringify({ path: result.path, restartRequired: true }, null, 2)}\n`);
    return;
  }
  if (command === "inspect-reasoning") {
    if (!args.includes("--confirm")) {
      throw new TypeError("inspect-reasoning requires --confirm because it prints private transcript content");
    }
    const sessionId = option(args, "--session");
    if (sessionId === undefined) throw new TypeError("inspect-reasoning requires --session SESSION_ID");
    const config = await readCaptureConfig(configPath(args));
    const state = await new StateStore(config.stateRoot).load();
    const session = Object.values(state.sessions).find((candidate) => candidate.sessionId === sessionId);
    if (session?.transcriptPath === undefined) throw new Error(`session transcript is unavailable: ${sessionId}`);
    const limitInput = option(args, "--limit");
    const limit = limitInput === undefined ? 100 : Number(limitInput);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 10_000) {
      throw new TypeError("--limit must be an integer between 1 and 10000");
    }
    const result = await readExposedReasoningDelta(session.transcriptPath, session.source);
    process.stdout.write(`${JSON.stringify({
      sessionId,
      exposedReasoningCount: result.items.length,
      returned: Math.min(limit, result.items.length),
      truncated: result.items.length > limit,
      items: result.items.slice(-limit),
    }, null, 2)}\n`);
    return;
  }
  if (command === "export") {
    const output = option(args, "--output");
    if (output === undefined) throw new TypeError("export requires --output PATH");
    const config = await readCaptureConfig(configPath(args));
    const manifest = await exportCaptureData(config, output, {
      includeVaultKey: args.includes("--include-vault-key"),
      ...(process.env.SUPER_BRAIN_EXPORT_TOKEN === undefined
        ? {}
        : { apiToken: process.env.SUPER_BRAIN_EXPORT_TOKEN }),
    });
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return;
  }
  if (command === "verify-export") {
    const input = option(args, "--input");
    if (input === undefined) throw new TypeError("verify-export requires --input PATH");
    process.stdout.write(`${JSON.stringify(await verifyCaptureExport(input), null, 2)}\n`);
    return;
  }
  if (command === "prune") {
    const before = option(args, "--before");
    if (before === undefined) throw new TypeError("prune requires --before ISO_DATE");
    const beforeMs = Date.parse(before);
    if (!Number.isFinite(beforeMs)) throw new TypeError("--before must be an ISO date or timestamp");
    const config = await readCaptureConfig(configPath(args));
    const result = await pruneHookArtifacts(config, beforeMs, args.includes("--confirm"));
    process.stdout.write(`${JSON.stringify({ mode: args.includes("--confirm") ? "delete" : "dry-run", ...result }, null, 2)}\n`);
    return;
  }
  if (command === "retry-failed") {
    const config = await readCaptureConfig(configPath(args));
    const result = await new DurableSpool(config.stateRoot).retryFailed(
      args.includes("--confirm"),
      {
        rebaseEvents: args.includes("--rebase-events"),
        rebaseTrajectories: args.includes("--rebase-trajectories"),
      },
    );
    process.stdout.write(`${JSON.stringify({ mode: args.includes("--confirm") ? "retry" : "dry-run", ...result }, null, 2)}\n`);
    return;
  }
  if (command === "resolve-failed") {
    const reason = option(args, "--reason");
    if (reason === undefined) throw new TypeError("resolve-failed requires --reason TEXT");
    const config = await readCaptureConfig(configPath(args));
    const result = await new DurableSpool(config.stateRoot).resolveFailed(reason, args.includes("--confirm"));
    process.stdout.write(`${JSON.stringify({ mode: args.includes("--confirm") ? "resolve" : "dry-run", ...result }, null, 2)}\n`);
    return;
  }
  if (command === "status") {
    const config = await readCaptureConfig(configPath(args));
    const response = await fetch(`http://${config.bindHost}:${config.port}/health`, { signal: AbortSignal.timeout(2_000) });
    process.stdout.write(`${await response.text()}\n`);
    process.exitCode = response.ok ? 0 : 1;
    return;
  }
  if (command === "config") {
    const config = await readCaptureConfig(configPath(args));
    const safe = { ...config, apiToken: "[REDACTED]", hookToken: "[REDACTED]", operatorToken: "[REDACTED]" };
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
    return;
  }
  if (command === "help") {
    process.stdout.write("Usage: super-brain-capture <init|run|relay|checkpoint|decision|status|config|configure|rotate-operator-token|inspect-reasoning|install-hooks|install-hermes-hook|install-service|enable-vault-encryption|export|verify-export|prune|retry-failed|resolve-failed> [--config PATH]\n");
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
