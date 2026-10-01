import type { HookSource } from "./types.js";

export class CaptureRelayHttpError extends Error {
  constructor(readonly status: number) {
    super(`capture daemon rejected the request with HTTP ${status}`);
    this.name = "CaptureRelayHttpError";
  }
}

export interface CaptureRelayRequest {
  readonly url: string;
  readonly source: HookSource;
  readonly token: string;
  readonly body: string;
  readonly fetcher?: typeof fetch;
  readonly attempts?: number;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
}

export function captureRelayFallbackEligible(error: unknown): boolean {
  return error instanceof TypeError || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function postCaptureRelay(request: CaptureRelayRequest): Promise<void> {
  const attempts = request.attempts ?? 2;
  const timeoutMs = request.timeoutMs ?? 2_000;
  const retryDelayMs = request.retryDelayMs ?? 750;
  if (!Number.isInteger(attempts) || attempts < 1) throw new TypeError("relay attempts must be a positive integer");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("relay timeout must be positive");
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) throw new TypeError("relay retry delay cannot be negative");

  const fetcher = request.fetcher ?? fetch;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetcher(request.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agent-source": request.source,
          "x-super-brain-hook-token": request.token,
        },
        body: request.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new CaptureRelayHttpError(response.status);
      return;
    } catch (error) {
      // Node fetch reports connection failures as TypeError. TimeoutError means
      // the daemon already had a full attempt and another one could exceed the
      // coding host's five-second hook budget.
      const retryable = error instanceof TypeError;
      if (!retryable || attempt === attempts) throw error;
      if (retryDelayMs > 0) await delay(retryDelayMs);
    }
  }
}
