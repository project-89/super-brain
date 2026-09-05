import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { normalizeHookEvidence } from "./evidence.js";
import { CaptureReceiptQueue, receiptEncryptionKey } from "./receipts.js";
import { CaptureEngine } from "./capture.js";
import { DurableSpool, readHookVaultArtifact, readRelayFailureSummary } from "./storage.js";
import { readTranscriptArtifactPage, type TranscriptVaultSource } from "./transcript-vault.js";
import type { CaptureConfig, CapturePolicyPatch, CapturePolicySettings, HookSource } from "./types.js";

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage, expected: string, header: string): boolean {
  const actual = request.headers[header];
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function policy(config: CaptureConfig): CapturePolicySettings {
  return {
    reasoningPolicy: config.reasoningPolicy,
    retainEncryptedReasoning: config.retainEncryptedReasoning,
    reasoningTreePolicy: config.reasoningTreePolicy,
    treeSnapshotEveryEvents: config.treeSnapshotEveryEvents,
    anonymizationPolicy: config.anonymizationPolicy,
    ...(config.repositoryCapture === undefined ? {} : { repositoryCapture: config.repositoryCapture }),
  };
}

function policyPatch(value: Record<string, unknown>): CapturePolicyPatch {
  const allowed = new Set([
    "reasoningPolicy",
    "retainEncryptedReasoning",
    "reasoningTreePolicy",
    "treeSnapshotEveryEvents",
    "anonymizationPolicy",
    "repositoryCapture",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new TypeError(`unknown capture policy fields: ${unknown.join(", ")}`);
  return value as CapturePolicyPatch;
}

export function hookSource(headerValue: string | undefined, payloadValue: unknown): HookSource {
  const value = headerValue === "claude" || headerValue === "claude-code" || headerValue === "codex" || headerValue === "hermes"
    ? headerValue
    : typeof payloadValue === "string"
      ? payloadValue
      : undefined;
  if (value === "claude" || value === "claude-code") return "claude-code";
  if (value === "codex") return "codex";
  if (value === "hermes") return "hermes";
  return "unknown";
}

async function jsonBody(request: IncomingMessage, limit = 2 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > limit) throw new TypeError("request body exceeds 2 MiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  } catch {
    throw new TypeError("request body must be valid JSON");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export class CaptureHttpServer {
  private server: Server | undefined;
  private receipts?: CaptureReceiptQueue;
  private receiptTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly config: CaptureConfig,
    private readonly engine: CaptureEngine,
    private readonly spool: DurableSpool,
    private readonly updatePolicy?: (patch: CapturePolicyPatch) => Promise<CaptureConfig>,
    private readonly vaultEncryptionKey?: Uint8Array,
  ) {}

  async start(): Promise<{ readonly host: string; readonly port: number }> {
    if (this.server !== undefined) throw new Error("capture server is already running");
    this.receipts = new CaptureReceiptQueue(this.engine, await receiptEncryptionKey(this.config));
    await this.receipts.initialize();
    this.receipts.start();
    this.receiptTimer = setInterval(() => this.receipts?.start(), 1_000);
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, this.config.bindHost, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    return {
      host: this.config.bindHost,
      port: typeof address === "object" && address !== null ? address.port : this.config.port,
    };
  }

  async close(): Promise<void> {
    if (this.receiptTimer !== undefined) clearInterval(this.receiptTimer);
    await this.receipts?.idle();
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://capture.local");
      if (request.method === "GET" && url.pathname === "/health") {
        const [spool, relayFailures, receipts] = await Promise.all([
          this.spool.snapshot(),
          readRelayFailureSummary(this.config.stateRoot),
          this.receipts!.snapshot(),
        ]);
        send(response, 200, {
          status: "ok",
          ...this.engine.snapshot(),
          ...spool,
          relayFailures,
          receipts,
          policy: {
            reasoning: this.config.reasoningPolicy,
            encryptedReasoning: this.config.retainEncryptedReasoning ? "retain" : "exclude",
            reasoningTrees: this.config.reasoningTreePolicy,
            anonymization: this.config.anonymizationPolicy,
            treeSnapshotEveryEvents: this.config.treeSnapshotEveryEvents,
          },
        });
        return;
      }
      if (url.pathname === "/settings") {
        if (!authorized(request, this.config.operatorToken, "x-super-brain-operator-token")) {
          send(response, 401, { error: "unauthorized" });
          return;
        }
        if (request.method === "GET") {
          send(response, 200, { policy: policy(this.config), restartRequired: false });
          return;
        }
        if (request.method === "PATCH" && this.updatePolicy !== undefined) {
          const updated = await this.updatePolicy(policyPatch(object(await jsonBody(request))));
          send(response, 200, { policy: policy(updated), restartRequired: true });
          return;
        }
        send(response, 405, { error: "method_not_allowed" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/acceptance-context") {
        if (!authorized(request, this.config.operatorToken, "x-super-brain-operator-token")) { send(response, 401, { error: "unauthorized" }); return; }
        const source = hookSource(undefined, url.searchParams.get("source"));
        const sessionId = url.searchParams.get("sessionId");
        if (sessionId === null || sessionId.length === 0) throw new TypeError("acceptance context requires sessionId");
        send(response, 200, await this.engine.acceptanceContext(source, sessionId));
        return;
      }
      const artifactMatch = /^\/artifacts\/(claude-code|codex)\/([a-f0-9]{64})$/i.exec(url.pathname);
      if (artifactMatch !== null) {
        if (!authorized(request, this.config.operatorToken, "x-super-brain-operator-token")) {
          send(response, 401, { error: "unauthorized" });
          return;
        }
        if (request.method !== "GET") {
          send(response, 405, { error: "method_not_allowed" });
          return;
        }
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 100 : Number(rawLimit);
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new TypeError("limit must be an integer within [1, 200]");
        send(response, 200, await readTranscriptArtifactPage({
          vaultRoot: this.config.vaultRoot,
          ...(this.vaultEncryptionKey === undefined ? {} : { encryptionKey: this.vaultEncryptionKey }),
          source: artifactMatch[1] as TranscriptVaultSource,
          sha256: artifactMatch[2]!.toLowerCase(),
          limit,
          rawCursor: url.searchParams.get("cursor"),
        }));
        return;
      }
      const hookArtifactMatch = /^\/hook-artifacts\/(claude-code|codex|hermes|unknown)\/([a-f0-9]{64})$/i.exec(url.pathname);
      if (hookArtifactMatch !== null) {
        if (!authorized(request, this.config.operatorToken, "x-super-brain-operator-token")) {
          send(response, 401, { error: "unauthorized" });
          return;
        }
        if (request.method !== "GET") {
          send(response, 405, { error: "method_not_allowed" });
          return;
        }
        const artifact = await readHookVaultArtifact({
          vaultRoot: this.config.vaultRoot,
          source: hookArtifactMatch[1]!.toLowerCase() as HookSource,
          artifactId: hookArtifactMatch[2]!.toLowerCase(),
          ...(this.vaultEncryptionKey === undefined ? {} : { encryptionKey: this.vaultEncryptionKey }),
        });
        if (artifact === undefined) {
          send(response, 404, { error: "artifact_not_found" });
          return;
        }
        send(response, 200, { artifact });
        return;
      }
      if (request.method !== "POST" || !["/hook", "/checkpoint", "/decision"].includes(url.pathname)) {
        send(response, 404, { error: "not_found" });
        return;
      }
      const hasHookCredential = authorized(request, this.config.hookToken, "x-super-brain-hook-token");
      const hasOperatorAuthority = this.config.operatorToken !== this.config.hookToken &&
        authorized(request, this.config.operatorToken, "x-super-brain-operator-token");
      if (!hasHookCredential && !hasOperatorAuthority) {
        send(response, 401, { error: "unauthorized" });
        return;
      }
      const body = object(await jsonBody(request));
      const eventName = url.pathname === "/checkpoint" ? "ReasoningCheckpoint" : url.pathname === "/decision" ? "HumanDecision" : undefined;
      const payload = eventName === undefined ? body : { ...body, hook_event_name: eventName };
      const human = normalizeHookEvidence(payload).name === "HumanDecision";
      if (human ? !hasOperatorAuthority : !authorized(request, this.config.hookToken, "x-super-brain-hook-token")) {
        send(response, 401, { error: human ? "operator_authority_required" : "unauthorized" });
        return;
      }
      const authority = human ? { kind: "local-operator" as const, principalId: `operator:${this.config.sensorId}`, authenticatedAt: new Date().toISOString() } : undefined;
      const receiptHeader = request.headers["x-super-brain-receipt-id"];
      const occurredHeader = request.headers["x-super-brain-occurred-at"];
      const occurredAt = typeof occurredHeader === "string" && Number.isFinite(Date.parse(occurredHeader)) ? new Date(occurredHeader).toISOString() : new Date().toISOString();
      const result = await this.receipts!.accept({
        version: 1, id: typeof receiptHeader === "string" ? receiptHeader : randomUUID(), occurredAt,
        source: hookSource(request.headers["x-agent-source"] as string | undefined, body.source),
        endpoint: url.pathname as "/hook" | "/checkpoint" | "/decision", payload,
      }, authority);
      send(response, 202, result);
      this.receipts!.start();
    } catch (error) {
      const invalid = error instanceof TypeError;
      if (!invalid) response.setHeader("retry-after", "1");
      send(response, invalid ? 400 : 503, { error: invalid ? error.message : "capture_temporarily_unavailable" });
    }
  }
}
