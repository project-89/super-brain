#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SuperBrainClient } from "@_89/super-brain-client";
import { CaptureBridge } from "./capture.js";
import { NodeTelemetryOutbox } from "./outbox.js";
import { createSuperBrainMcpServer } from "./server.js";

const required = (value: string | undefined, label: string) => { if (!value?.trim()) throw new TypeError(`${label} is required`); return value; };
let api: SuperBrainClient;
const outbox = new NodeTelemetryOutbox({
  directory: process.env.SUPER_BRAIN_TELEMETRY_STATE_ROOT ?? join(homedir(), ".local", "state", "super-brain", "mcp-telemetry"),
  identity: async (signal) => { const identity = await api.identity({ signal }); return { ...identity, organizationId: identity.organizationId ?? "local" }; },
  send: (batch, signal) => api.recordMemoryFeedbackBatch(batch.items, { stamp: batch.stamp, expectedSubject: batch.subject, signal, timeoutMs: 5000 }),
});
api = new SuperBrainClient({
  baseUrl: required(process.env.SUPER_BRAIN_URL ?? process.env.FOLD_API_URL, "SUPER_BRAIN_URL"),
  organizationId: process.env.SUPER_BRAIN_ORGANIZATION ?? process.env.FOLD_API_ORGANIZATION ?? "local",
  workspaceId: required(process.env.SUPER_BRAIN_WORKSPACE ?? process.env.FOLD_API_WORKSPACE, "SUPER_BRAIN_WORKSPACE"),
  token: () => process.env.SUPER_BRAIN_TOKEN ?? process.env.FOLD_API_TOKEN,
  telemetryOutbox: outbox,
  recallTelemetry: { ...(process.env.SUPER_BRAIN_SESSION_ID === undefined ? {} : { sessionId: process.env.SUPER_BRAIN_SESSION_ID }),
    ...(process.env.SUPER_BRAIN_CANONICAL_TASK_ID === undefined ? {} : { taskId: process.env.SUPER_BRAIN_CANONICAL_TASK_ID }) },
});
const captureUrl = process.env.SUPER_BRAIN_CAPTURE_URL;
const captureToken = process.env.SUPER_BRAIN_CAPTURE_HOOK_TOKEN;
const source = process.env.SUPER_BRAIN_HARNESS ?? "hermes";
if (source !== "codex" && source !== "claude-code" && source !== "hermes") throw new TypeError("unsupported capture harness");
const capture = captureUrl === undefined || captureToken === undefined ? undefined : new CaptureBridge({ baseUrl: captureUrl, token: captureToken, source,
  ...(process.env.SUPER_BRAIN_SESSION_ID === undefined ? {} : { sessionId: process.env.SUPER_BRAIN_SESSION_ID }),
  ...(process.env.SUPER_BRAIN_PROJECT_ROOT === undefined ? {} : { cwd: process.env.SUPER_BRAIN_PROJECT_ROOT }) });
const server = createSuperBrainMcpServer({ api, telemetry: outbox, ...(capture === undefined ? {} : { capture }) });
const timer = setInterval(() => { void outbox.flush({ maxBatches: 10 }).catch(() => undefined); }, 5000);
timer.unref();
let closing = false;
const close = async () => { if (closing) return; closing = true; clearInterval(timer); await server.close(); await outbox.close(); };
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
const transport = new StdioServerTransport();
transport.onclose = () => { void close(); };
await server.connect(transport);
