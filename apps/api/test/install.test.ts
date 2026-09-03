import { describe, expect, it } from "vitest";

import { apiLaunchAgentPlist } from "../src/install.js";

describe("API service installation", () => {
  it("generates a persistent private-environment launch agent", () => {
    const plist = apiLaunchAgentPlist({
      executable: "/repo/apps/api/dist/main.js",
      environment: {
        FOLD_API_CREDENTIALS_JSON: "{\"token\":\"a&b\"}",
        FOLD_API_PORT: "3003",
      },
      workingDirectory: "/repo",
      stateRoot: "/state/api",
    });
    expect(plist).toContain("com.super-brain.api");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("a&amp;b");
    expect(plist).toContain("/state/api/service.error.log");
  });
});
