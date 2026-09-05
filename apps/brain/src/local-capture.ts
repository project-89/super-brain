import { SuperBrainApiError } from "@_89/super-brain-client";
import type { ConnectionSettings } from "./types";

/** Operator credentials may only travel to the explicit same-origin proxy or a loopback capture service. */
export function captureDestination(value: string, canonicalBaseUrl: string): string {
  const base = value.trim().replace(/\/$/, "");
  if (!base || base.includes("\\") || base.includes("%") || base.startsWith("//")) throw new SuperBrainApiError(0, "capture_destination_invalid", "Choose the local capture service or /capture proxy");
  if (base === "/capture") {
    if (canonicalBaseUrl.replace(/\/$/, "") === base) throw new SuperBrainApiError(0, "capture_destination_invalid", "Capture and canonical API destinations must be separate");
    return base;
  }
  let url: URL;
  try { url = new URL(base); } catch { throw new SuperBrainApiError(0, "capture_destination_invalid", "Capture service must be a loopback URL or /capture"); }
  if (!["http:", "https:"].includes(url.protocol) || !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) || url.username || url.password || url.search || url.hash || !["/", "/capture"].includes(url.pathname) || base === canonicalBaseUrl.replace(/\/$/, "")) throw new SuperBrainApiError(0, "capture_destination_invalid", "Operator access is restricted to the local capture service");
  try {
    const canonical = new URL(canonicalBaseUrl, globalThis.location?.origin ?? "http://relative.invalid");
    const loopback = (host: string) => ["127.0.0.1", "[::1]", "localhost"].includes(host);
    if (url.protocol === canonical.protocol && url.port === canonical.port && (url.hostname === canonical.hostname || loopback(url.hostname) && loopback(canonical.hostname))) throw new SuperBrainApiError(0, "capture_destination_invalid", "Capture and canonical API services must be separate");
  } catch (error) { if (error instanceof SuperBrainApiError) throw error; }
  return base;
}

export async function localCaptureRequest<T>(settings: ConnectionSettings, path: string, options: { readonly operator?: boolean; readonly signal?: AbortSignal; readonly method?: "GET" | "PATCH"; readonly body?: unknown; readonly timeoutMs?: number } = {}): Promise<T> {
  const base = captureDestination(settings.captureBaseUrl, settings.baseUrl);
  if (options.operator !== false && !settings.captureOperatorToken) throw new SuperBrainApiError(0, "operator_unavailable", "Connect a local operator token to inspect private capture evidence");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  const signal = options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);
  try {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET", redirect: "error", credentials: "omit", signal,
      headers: { ...(options.operator === false ? {} : { "x-super-brain-operator-token": settings.captureOperatorToken }), ...(options.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body = await response.json() as T & { readonly error?: string };
    if (!response.ok) throw new SuperBrainApiError(response.status, "capture_request_failed", body.error ?? `Local capture request failed (${response.status})`);
    return body;
  } catch (error) {
    if (error instanceof SuperBrainApiError) throw error;
    if (signal.aborted) throw new SuperBrainApiError(0, options.signal?.aborted ? "aborted" : "timeout", options.signal?.aborted ? "Request cancelled" : "Local capture request timed out");
    throw new SuperBrainApiError(0, "capture_unavailable", "Local capture service is unavailable");
  } finally { clearTimeout(timer); }
}
