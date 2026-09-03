#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CaptureEngine } from "./capture.js";
import { defaultConfigPath, initializeCaptureConfig, readCaptureConfig } from "./config.js";
import { SpoolProcessor } from "./delivery.js";
import { installHooks, installLaunchAgent } from "./install.js";
import { CaptureHttpServer } from "./server.js";
import { DurableSpool, HookVault, StateStore } from "./storage.js";
import type { HookSource, ReasoningPolicy } from "./types.js";

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
  }
}

async function run(args: readonly string[]): Promise<void> {
  const config = await readCaptureConfig(configPath(args));
  const spool = new DurableSpool(config.stateRoot);
  const engine = new CaptureEngine(
    config,
    new StateStore(config.stateRoot),
    new HookVault(config.vaultRoot),
    spool,
  );
  await engine.initialize();
  const processor = new SpoolProcessor(config, spool);
  const server = new CaptureHttpServer(config, engine, spool);
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
  const args = process.argv.slice(2);
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
    const result = await initializeCaptureConfig({
      path: configPath(args),
      apiToken,
      ...(option(args, "--api-url") === undefined ? {} : { apiUrl: option(args, "--api-url")! }),
      ...(option(args, "--workspace") === undefined ? {} : { workspaceId: option(args, "--workspace")! }),
      ...(option(args, "--state-root") === undefined ? {} : { stateRoot: option(args, "--state-root")! }),
      ...(option(args, "--vault") === undefined ? {} : { vaultRoot: option(args, "--vault")! }),
      ...(reasoning === undefined ? {} : { reasoningPolicy: reasoning }),
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
  if (command === "status") {
    const config = await readCaptureConfig(configPath(args));
    const response = await fetch(`http://${config.bindHost}:${config.port}/health`, { signal: AbortSignal.timeout(2_000) });
    process.stdout.write(`${await response.text()}\n`);
    process.exitCode = response.ok ? 0 : 1;
    return;
  }
  if (command === "config") {
    const config = await readCaptureConfig(configPath(args));
    const safe = { ...config, apiToken: "[REDACTED]", hookToken: "[REDACTED]" };
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
    return;
  }
  if (command === "help") {
    process.stdout.write("Usage: super-brain-capture <init|run|relay|checkpoint|decision|status|config|install-hooks|install-service> [--config PATH]\n");
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
