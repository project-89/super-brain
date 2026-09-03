import { describe, expect, it } from "vitest";

import { memoryWorkerLaunchAgentPlist } from "../src/install.js";

describe("memory worker service installation", () => {
  it("generates an auto-promoting resumable watcher", () => {
    const plist = memoryWorkerLaunchAgentPlist({
      executable: "/repo/apps/memory-worker/dist/main.js",
      environment: {
        SUPER_BRAIN_TOKEN: "a&b",
        SUPER_BRAIN_URL: "http://127.0.0.1:3003",
      },
      stateRoot: "/state/worker",
      consumerId: "memory-v1",
      autoPromote: true,
      replayAll: false,
    });
    expect(plist).toContain("com.super-brain.memory-worker");
    expect(plist).toContain("<string>watch</string>");
    expect(plist).toContain("<string>--auto-promote</string>");
    expect(plist).not.toContain("<string>--replay-all</string>");
    expect(plist).toContain("a&amp;b");
  });
});
