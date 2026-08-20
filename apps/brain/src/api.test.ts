import { afterEach, describe, expect, it, vi } from "vitest";

import { FoldApiClient } from "./api";

const client = new FoldApiClient({
  baseUrl: "/api",
  workspaceId: "workspace/one",
  token: "secret-token",
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Fold API client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("encodes workspace and repeated event filters with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ entries: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await client.listEvents({ includeDrafts: true, kinds: ["memory.recorded", "agent status"] });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "/api/v1/workspaces/workspace%2Fone/events?include=canon%2Bdraft&kind=memory.recorded&kind=agent+status",
    );
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer secret-token");
  });

  it("forms a server-scoped personal-memory create request", async () => {
    const memory = { id: "memory-id" };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ memory }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      client.createMemory({
        source: "conversation",
        summary: "Decision",
        content: { decision: "Ship the client" },
        tags: ["decision"],
        spaceId: "space-a",
      }),
    ).resolves.toEqual(memory);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      stamp: { id: expect.any(String), t: expect.any(Number), worldDate: expect.any(String) },
      input: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        source: "conversation",
        summary: "Decision",
        content: { decision: "Ship the client" },
        tags: ["decision"],
        spaceId: "space-a",
      },
    });
    expect(body).not.toHaveProperty("input.creatorId");
    expect(body).not.toHaveProperty("input.workspaceId");
  });

  it("maps stable API errors and network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ error: { code: "workspace_access_denied", message: "Workspace access denied" } }, 403),
      ),
    );
    await expect(client.projection()).rejects.toMatchObject({
      status: 403,
      code: "workspace_access_denied",
      message: "Workspace access denied",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(client.projection()).rejects.toMatchObject({
      status: 0,
      code: "network_error",
    });
  });
});
