import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialConnection } from "./connection";

function storage(values: Readonly<Record<string, string>>): Storage {
  const entries = new Map(Object.entries(values));
  return {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, value); },
  };
}

describe("initialConnection", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", storage({
      "super-brain.connection": JSON.stringify({
        baseUrl: "/stale-api",
        organizationId: "stale-org",
        workspaceId: "stale-workspace",
        captureBaseUrl: "/stale-capture",
      }),
    }));
    vi.stubGlobal("sessionStorage", storage({
      "super-brain.token": "stale-token",
      "super-brain.capture-token": "stale-capture-token",
    }));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("prefers provisioned configuration over stale browser storage", () => {
    vi.stubEnv("VITE_FOLD_API_BASE_URL", "/api");
    vi.stubEnv("VITE_FOLD_ORGANIZATION", "local");
    vi.stubEnv("VITE_FOLD_WORKSPACE", "local-history");
    vi.stubEnv("VITE_FOLD_TOKEN", "owner-token");
    vi.stubEnv("VITE_CAPTURE_BASE_URL", "/capture");
    vi.stubEnv("VITE_CAPTURE_OPERATOR_TOKEN", "operator-token");

    expect(initialConnection()).toEqual({
      baseUrl: "/api",
      organizationId: "local",
      workspaceId: "local-history",
      token: "owner-token",
      captureBaseUrl: "/capture",
      captureOperatorToken: "operator-token",
    });
  });
});
