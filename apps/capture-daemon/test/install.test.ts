import { describe, expect, it } from "vitest";

import { captureLaunchAgentPlist } from "../src/index.js";

describe("capture launch agent", () => {
  it("starts at login and continuously restarts a background daemon", () => {
    const plist = captureLaunchAgentPlist({
      executable: "/workspace/capture/main.js",
      configPath: "/home/user/.config/super-brain/capture.json",
      stateRoot: "/home/user/.local/state/super-brain/capture",
    });

    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>ProcessType</key><string>Background</string>");
    expect(plist).toContain("<key>ThrottleInterval</key><integer>5</integer>");
    expect(plist).toContain("/workspace/capture/main.js");
    expect(plist).toContain("/home/user/.config/super-brain/capture.json");
  });
});
