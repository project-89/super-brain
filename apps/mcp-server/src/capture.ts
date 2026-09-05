import { randomUUID } from "node:crypto";

export interface CaptureCheckpoint {
  readonly kind: "reasoning";
  readonly summary: string;
  readonly hypothesis?: string;
  readonly evidence?: string;
  readonly decision?: string;
  readonly confidence?: number;
}

export interface CaptureBridgeOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly source: "codex" | "claude-code" | "hermes";
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly fetch?: typeof fetch;
}

export class CaptureBridge {
  private readonly fetchImpl: typeof fetch;
  private readonly sessionId: string;

  constructor(private readonly options: CaptureBridgeOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sessionId = options.sessionId?.trim() || `mcp:${options.source}:${randomUUID()}`;
  }

  async checkpoint(input: CaptureCheckpoint, stamp?: { readonly id: string; readonly t: number }, signal?: AbortSignal): Promise<{ readonly accepted: true; readonly artifactId: string }> {
    if (input.kind !== "reasoning") throw new TypeError("MCP capture cannot assert a human decision");
    return this.post("checkpoint", { ...input }, stamp, signal);
  }

  async steering(intentionIds: readonly string[], signal?: AbortSignal): Promise<{ readonly accepted: true; readonly artifactId: string }> {
    const ids = [...new Set(intentionIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > 20) throw new TypeError("steering capture requires 1 to 20 intention IDs");
    return this.post("hook", { hook_event_name: "SteeringApplied", intention_ids: ids }, undefined, signal);
  }

  private async post(
    endpoint: string,
    input: Readonly<Record<string, unknown>>,
    stamp?: { readonly id: string; readonly t: number },
    signal?: AbortSignal,
  ): Promise<{ readonly accepted: true; readonly artifactId: string }> {
    const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      signal: signal === undefined ? AbortSignal.timeout(3000) : AbortSignal.any([signal, AbortSignal.timeout(3000)]),
      headers: {
        "content-type": "application/json",
        "x-agent-source": this.options.source,
        "x-super-brain-hook-token": this.options.token,
        ...(stamp === undefined ? {} : { "x-super-brain-receipt-id": stamp.id, "x-super-brain-occurred-at": new Date(stamp.t).toISOString() }),
      },
      body: JSON.stringify({
        ...input,
        session_id: this.sessionId,
        cwd: this.options.cwd ?? process.cwd(),
      }),
    });
    const body = await response.json() as { readonly accepted?: boolean; readonly artifactId?: string; readonly error?: string };
    if (!response.ok || body.accepted !== true || body.artifactId === undefined) {
      throw new Error(body.error ?? `capture daemon returned HTTP ${response.status}`);
    }
    return { accepted: true, artifactId: body.artifactId };
  }
}
