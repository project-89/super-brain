import { describe, expect, it } from "vitest";

import { apiLaunchAgentPlist, apiServiceEnvironment } from "../src/install.js";

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

  it("accepts complete Clerk service configuration and rejects partial configuration", () => {
    expect(apiServiceEnvironment({
      CLERK_SECRET_KEY: "sk_test",
      CLERK_PUBLISHABLE_KEY: "pk_test",
      FOLD_CLERK_AUTHORIZED_PARTIES: "https://brain.example",
      FOLD_CLERK_BINDINGS_JSON: "{}",
      FOLD_DATABASE_URL: "postgres://database/super_brain",
    })).toMatchObject({ CLERK_SECRET_KEY: "sk_test" });
    expect(() => apiServiceEnvironment({
      FOLD_API_CREDENTIALS_JSON: "{}",
      CLERK_PUBLISHABLE_KEY: "pk_test",
    })).toThrow(/CLERK_SECRET_KEY/);
  });
});
