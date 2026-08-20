import type { ConnectionSettings } from "./types";

const SETTINGS_KEY = "super-brain.connection";
const TOKEN_KEY = "super-brain.token";

interface StoredConnection {
  readonly baseUrl?: string;
  readonly workspaceId?: string;
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
    baseUrl: normalizedBaseUrl(stored.baseUrl ?? import.meta.env.VITE_FOLD_API_BASE_URL ?? "/api"),
    workspaceId: (stored.workspaceId ?? import.meta.env.VITE_FOLD_WORKSPACE ?? "").trim(),
    token: sessionStorage.getItem(TOKEN_KEY) ?? import.meta.env.VITE_FOLD_TOKEN ?? "",
  };
}

export function saveConnection(settings: ConnectionSettings): ConnectionSettings {
  const normalized = {
    baseUrl: normalizedBaseUrl(settings.baseUrl),
    workspaceId: settings.workspaceId.trim(),
    token: settings.token.trim(),
  };
  localStorage.setItem(
    SETTINGS_KEY,
    JSON.stringify({ baseUrl: normalized.baseUrl, workspaceId: normalized.workspaceId }),
  );
  sessionStorage.setItem(TOKEN_KEY, normalized.token);
  return normalized;
}
