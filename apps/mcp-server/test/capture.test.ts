import { describe, expect, it, vi } from "vitest";

import { CaptureBridge } from "../src/index.js";

describe("MCP capture bridge", () => {
  it("sends structured checkpoints to the authenticated local daemon", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ accepted: true, artifactId: "artifact-a" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
    const bridge = new CaptureBridge({
      baseUrl: "http://127.0.0.1:3210/",
      token: "hook-secret",
      source: "hermes",
      sessionId: "session-a",
      cwd: "/workspace/project-a",
      fetch: fetchMock,
    });
    await expect(bridge.checkpoint({ kind: "reasoning", summary: "Prefer the canonical event log", confidence: 0.9 }))
      .resolves.toEqual({ accepted: true, artifactId: "artifact-a" });
    const [url, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3210/checkpoint");
    expect(new Headers(init.headers).get("x-agent-source")).toBe("hermes");
    expect(new Headers(init.headers).get("x-super-brain-hook-token")).toBe("hook-secret");
    expect(JSON.parse(String(init.body))).toMatchObject({ session_id: "session-a", cwd: "/workspace/project-a" });
  });
});
