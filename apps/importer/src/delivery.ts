import {
  transcriptImportBundleSchema,
  transcriptRunSchema,
  type TranscriptImportBundle,
  type TranscriptRun,
} from "@_89/fold-transcript";

export interface TranscriptDeliveryOptions {
  readonly apiUrl: string;
  readonly organizationId?: string;
  readonly workspaceId: string;
  readonly bearerToken: string;
  readonly maxAttempts?: number;
  readonly fetcher?: typeof fetch;
}

export interface TranscriptDeliveryResult {
  readonly imported: boolean;
  readonly eventCount: number;
  readonly run: TranscriptRun;
}

export class TranscriptDeliveryError extends Error {
  override readonly name = "TranscriptDeliveryError";

  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

function endpoint(options: TranscriptDeliveryOptions, resource: string): string {
  let url: URL;
  try {
    url = new URL(options.apiUrl);
  } catch {
    throw new TypeError("transcript API URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError("transcript API URL must be an absolute HTTP(S) URL");
  }
  if (options.workspaceId.trim().length === 0) {
    throw new TypeError("transcript workspace id must not be empty");
  }
  if (options.bearerToken.trim().length === 0) {
    throw new TypeError("transcript bearer token must not be empty");
  }
  const workspace = encodeURIComponent(options.workspaceId);
  const scope = options.organizationId === undefined
    ? `/v1/workspaces/${workspace}`
    : `/v1/organizations/${encodeURIComponent(options.organizationId)}/workspaces/${workspace}`;
  return `${options.apiUrl.replace(/\/+$/, "")}${scope}/${resource}`;
}

function responseError(status: number, body: unknown): TranscriptDeliveryError {
  const error = typeof body === "object" && body !== null && "error" in body
    ? (body as { readonly error?: unknown }).error
    : undefined;
  const code = typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;
  const message = typeof error === "object" && error !== null && "message" in error &&
    typeof (error as { readonly message?: unknown }).message === "string"
    ? (error as { readonly message: string }).message
    : `Transcript import failed with HTTP ${status}`;
  return new TranscriptDeliveryError(message, status, code);
}

function parseResult(body: unknown): TranscriptDeliveryResult {
  if (typeof body !== "object" || body === null) {
    throw new TranscriptDeliveryError("Transcript import returned an invalid response");
  }
  const candidate = body as Record<string, unknown>;
  if (
    typeof candidate.imported !== "boolean" ||
    typeof candidate.eventCount !== "number" ||
    !Number.isInteger(candidate.eventCount) ||
    candidate.eventCount < 0
  ) {
    throw new TranscriptDeliveryError("Transcript import returned an invalid response");
  }
  return {
    imported: candidate.imported,
    eventCount: candidate.eventCount,
    run: transcriptRunSchema.parse(candidate.run),
  };
}

export async function deliverTranscriptBundle(
  input: TranscriptImportBundle,
  options: TranscriptDeliveryOptions,
): Promise<TranscriptDeliveryResult> {
  const bundle = transcriptImportBundleSchema.parse(input);
  const url = endpoint(options, "transcript-imports");
  const attempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) {
    throw new TypeError("transcript delivery attempts must be an integer within [1, 5]");
  }
  const fetcher = options.fetcher ?? fetch;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let retryDelayMs = 250 * attempt;
    try {
      const response = await fetcher(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.bearerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(bundle),
      });
      const body = await response.json().catch(() => undefined) as unknown;
      if (response.ok) return parseResult(body);
      const error = responseError(response.status, body);
      if (![429, 502, 503, 504].includes(response.status) || attempt === attempts) throw error;
      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get("retry-after"));
        if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
          retryDelayMs = Math.min(60_000, Math.ceil(retryAfterSeconds * 1_000));
        }
      }
      lastError = error;
    } catch (error) {
      if (error instanceof TranscriptDeliveryError && error.status !== undefined &&
        ![429, 502, 503, 504].includes(error.status)) throw error;
      lastError = error;
      if (attempt === attempts) break;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  if (lastError instanceof TranscriptDeliveryError) throw lastError;
  throw new TranscriptDeliveryError(
    lastError instanceof Error ? `Transcript API request failed: ${lastError.message}` : "Transcript API request failed",
  );
}

export async function listDeliveredTranscriptRunIds(
  options: TranscriptDeliveryOptions,
): Promise<ReadonlySet<string>> {
  const response = await (options.fetcher ?? fetch)(endpoint(options, "transcript-runs"), {
    headers: { authorization: `Bearer ${options.bearerToken}` },
  });
  const body = await response.json().catch(() => undefined) as unknown;
  if (!response.ok) throw responseError(response.status, body);
  if (typeof body !== "object" || body === null || !("runs" in body) || !Array.isArray(body.runs)) {
    throw new TranscriptDeliveryError("Transcript run catalog returned an invalid response");
  }
  return new Set(body.runs.map((run) => transcriptRunSchema.parse(run).id));
}
