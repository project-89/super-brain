import type { ConnectionSettings } from "./types";

const SETTINGS_KEY = "super-brain.connection";
const TOKEN_KEY = "super-brain.token";
const CAPTURE_TOKEN_KEY = "super-brain.capture-token";

interface StoredConnection {
  readonly baseUrl?: string;
  readonly organizationId?: string;
  readonly workspaceId?: string;
  readonly captureBaseUrl?: string;
}

function normalizedBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "/") return "";
  return trimmed.replace(/\/$/, "");
}

export function initialConnection(): ConnectionSettings {
  let stored: StoredConnection = {};
  try {
    stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as StoredConnection;
  } catch {
    localStorage.removeItem(SETTINGS_KEY);
  }
  return {
    baseUrl: normalizedBaseUrl(import.meta.env.VITE_FOLD_API_BASE_URL ?? stored.baseUrl ?? "/api"),
    organizationId: (import.meta.env.VITE_FOLD_ORGANIZATION ?? stored.organizationId ?? "local").trim(),
    workspaceId: (import.meta.env.VITE_FOLD_WORKSPACE ?? stored.workspaceId ?? "").trim(),
    token: import.meta.env.VITE_FOLD_TOKEN ?? sessionStorage.getItem(TOKEN_KEY) ?? "",
    captureBaseUrl: normalizedBaseUrl(import.meta.env.VITE_CAPTURE_BASE_URL ?? stored.captureBaseUrl ?? "/capture"),
    captureOperatorToken: import.meta.env.VITE_CAPTURE_OPERATOR_TOKEN ?? sessionStorage.getItem(CAPTURE_TOKEN_KEY) ?? "",
  };
}

export function saveConnection(settings: ConnectionSettings): ConnectionSettings {
  const normalized = {
    baseUrl: normalizedBaseUrl(settings.baseUrl),
    organizationId: settings.organizationId.trim(),
    workspaceId: settings.workspaceId.trim(),
    token: settings.token.trim(),
    captureBaseUrl: normalizedBaseUrl(settings.captureBaseUrl),
    captureOperatorToken: settings.captureOperatorToken.trim(),
  };
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({
      baseUrl: normalized.baseUrl,
      organizationId: normalized.organizationId,
      workspaceId: normalized.workspaceId,
      captureBaseUrl: normalized.captureBaseUrl,
    }),
  );
  sessionStorage.setItem(TOKEN_KEY, normalized.token);
  sessionStorage.setItem(CAPTURE_TOKEN_KEY, normalized.captureOperatorToken);
  return normalized;
}
