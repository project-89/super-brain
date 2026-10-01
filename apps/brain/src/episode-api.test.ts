import { afterEach, describe, expect, it, vi } from "vitest";
import { FoldApiClient } from "./api";
const api = new FoldApiClient({ baseUrl: "/api", organizationId: "org/one", workspaceId: "work/one", token: "private", captureBaseUrl: "/capture", captureOperatorToken: "" });
describe("episode read API", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("uses authenticated bounded cursor pages and exact source membership routes", async () => {
    const fetch = vi.fn().mockImplementation(async () => Response.json({ items: [], total: 0, coverage: "authorized-current-only" })); vi.stubGlobal("fetch", fetch);
    await api.workEpisodes({ cursor: "next+page", projectId: "project/one" });
    await api.episodeWindows({ cursor: "next" });
    await api.workEpisode("episode/one"); await api.episodeWindow("window/one");
    await api.episodeSources("episode/one", false, "next", "source/one", "revision+one");
    await api.episodeSources("window/one", true); await api.episodeHistory("episode/one", "next");
    const prefix = "/api/v1/organizations/org%2Fone/workspaces/work%2Fone/";
    expect(fetch.mock.calls.map(call => String(call[0]).replace(prefix, ""))).toEqual([
      "work-episodes?limit=100&pageCursor=next%2Bpage&projectId=project%2Fone", "work-episode-windows?limit=100&pageCursor=next",
      "work-episodes/episode%2Fone", "work-episode-windows/window%2Fone", "work-episodes/episode%2Fone/sources?limit=1&pageCursor=next&eventId=source%2Fone&revision=revision%2Bone",
      "work-episode-windows/window%2Fone/sources?limit=1", "work-episodes/episode%2Fone/history?limit=100&pageCursor=next",
    ]);
    for (const [, init] of fetch.mock.calls) { expect(new Headers(init.headers).get("authorization")).toBe("Bearer private"); expect(init.method ?? "GET").toBe("GET"); }
  });
  it("propagates unavailable evidence without stale or synthetic content", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: { code: "episode_unavailable", message: "Episode data is unavailable" } }, { status: 404 })));
    await expect(api.workEpisode("withdrawn")).rejects.toMatchObject({ status: 404, code: "episode_unavailable" });
  });
});
