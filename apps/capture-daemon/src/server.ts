import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { CaptureEngine } from "./capture.js";
import { DurableSpool, readRelayFailureSummary } from "./storage.js";
import type { CaptureConfig, HookSource } from "./types.js";

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const actual = request.headers["x-super-brain-hook-token"];
  if (typeof actual !== "string") return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
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
    if (length > limit) throw new Error("request body exceeds 2 MiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as unknown;
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export class CaptureHttpServer {
  private server: Server | undefined;

  constructor(
    private readonly config: CaptureConfig,
    private readonly engine: CaptureEngine,
    private readonly spool: DurableSpool,
  ) {}

  async start(): Promise<{ readonly host: string; readonly port: number }> {
    if (this.server !== undefined) throw new Error("capture server is already running");
    this.server = createServer((request, response) => void this.handle(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.port, this.config.bindHost, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    return { host: this.config.bindHost, port: this.config.port };
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) return;
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://capture.local");
      if (request.method === "GET" && url.pathname === "/health") {
        const [spool, relayFailures] = await Promise.all([
          this.spool.snapshot(),
          readRelayFailureSummary(this.config.stateRoot),
        ]);
        send(response, 200, { status: "ok", ...this.engine.snapshot(), ...spool, relayFailures });
        return;
      }
      if (request.method !== "POST" || !["/hook", "/checkpoint", "/decision"].includes(url.pathname)) {
        send(response, 404, { error: "not_found" });
        return;
      }
      if (!authorized(request, this.config.hookToken)) {
        send(response, 401, { error: "unauthorized" });
        return;
      }
      const body = object(await jsonBody(request));
      const eventName = url.pathname === "/checkpoint"
        ? "ReasoningCheckpoint"
        : url.pathname === "/decision"
          ? "HumanDecision"
          : undefined;
      const result = await this.engine.ingest(
        hookSource(request.headers["x-agent-source"] as string | undefined, body.source),
        eventName === undefined ? body : { ...body, hook_event_name: eventName },
      );
      send(response, 202, { accepted: true, artifactId: result.artifactId });
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : "invalid_request" });
    }
  }
}
