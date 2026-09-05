import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDestination, localCaptureRequest } from "./local-capture";
const settings = { baseUrl: "https://api.example.test", organizationId: "org", workspaceId: "workspace", token: "canonical-secret", captureBaseUrl: "/capture", captureOperatorToken: "operator-secret" };
describe("local operator boundary", () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each(["https://api.example.test", "//evil.test/capture", "https://evil.test", "http://127.0.0.1:3000/api", "/api", "/capture/../api", "http://user:secret@localhost:8377", "http://localhost:8377?redirect=evil", "http://127.0.0.1%2eevil.test"])("rejects %s before sending credentials", async (captureBaseUrl) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); await expect(localCaptureRequest({ ...settings, captureBaseUrl }, "/settings")).rejects.toMatchObject({ code: "capture_destination_invalid" }); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("supports only explicit local destinations and refuses credential-bearing redirects", async () => {
    expect(captureDestination("http://127.0.0.1:8377/", settings.baseUrl)).toBe("http://127.0.0.1:8377"); expect(captureDestination("http://[::1]:8377", settings.baseUrl)).toBe("http://[::1]:8377");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "redirect" }), { status: 302, headers: { location: "https://evil.test" } })); vi.stubGlobal("fetch", fetchMock);
    await expect(localCaptureRequest(settings, "/settings")).rejects.toMatchObject({ status: 302 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]; expect(init.redirect).toBe("error"); expect(new Headers(init.headers).get("authorization")).toBeNull(); expect(new Headers(init.headers).get("x-super-brain-operator-token")).toBe("operator-secret");
  });
  it("fails gracefully without local operator access", async () => { const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock); await expect(localCaptureRequest({ ...settings, captureOperatorToken: "" }, "/processing")).rejects.toMatchObject({ code: "operator_unavailable" }); expect(fetchMock).not.toHaveBeenCalled(); });
});

it("normalizes loopback aliases, case and default ports before excluding the canonical service", () => {
  expect(() => captureDestination("http://localhost:3003", "http://127.0.0.1:3003")).toThrow("separate");
  expect(() => captureDestination("HTTP://LOCALHOST:80", "http://127.0.0.1")).toThrow("separate");
  expect(() => captureDestination("http://[::1]:3003", "http://127.0.0.1:3003/api")).toThrow("separate");
});
