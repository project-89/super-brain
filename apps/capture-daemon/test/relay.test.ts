import { describe, expect, it, vi } from "vitest";

import { captureRelayFallbackEligible, CaptureRelayHttpError, postCaptureRelay } from "../src/index.js";

function request(fetcher: typeof fetch) {
  return {
    url: "http://127.0.0.1:8377/hook",
    source: "codex" as const,
    token: "hook-token",
    body: "{}",
    fetcher,
    retryDelayMs: 0,
  };
}

describe("capture hook relay", () => {
  it("retries one transient transport failure", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));

    await expect(postCaptureRelay(request(fetcher))).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry an HTTP rejection", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));

    await expect(postCaptureRelay(request(fetcher))).rejects.toEqual(new CaptureRelayHttpError(401));
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("does not retry a request timeout", async () => {
    const timeout = new DOMException("timed out", "TimeoutError");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(timeout);

    await expect(postCaptureRelay(request(fetcher))).rejects.toMatchObject({ name: "TimeoutError" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(captureRelayFallbackEligible(timeout)).toBe(true);
  });

  it("reports a transport failure after the bounded retry", async () => {
    const error = new TypeError("fetch failed");
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(error);

    await expect(postCaptureRelay(request(fetcher))).rejects.toBe(error);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
