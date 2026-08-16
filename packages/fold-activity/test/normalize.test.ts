import { describe, expect, it } from "vitest";

import {
  digestTerminalOutput,
  normalizeForMatching,
  stripAnsiPreserveText,
} from "../src/index.js";

describe("terminal normalization", () => {
  it("preserves visible text between ANSI segments", () => {
    const raw = "\u001b[38;2;215;119;87m*\u001b[39m \u001b[38;2;255;255;255mDone.\u001b[39m";
    expect(stripAnsiPreserveText(raw)).toBe("* Done.");
  });

  it("turns cursor-forward movement into spacing before matching", () => {
    expect(stripAnsiPreserveText("A\u001b[3CB")).toBe("A   B");
    expect(normalizeForMatching("A\u001b[3CB")).toBe("A B");
  });

  it("removes fragmented color payloads and terminal drawing noise", () => {
    expect(normalizeForMatching("foo 38;2;98;138;218m \u2584\u2584\u2584 bar")).toBe("foo bar");
  });

  it("run-length encodes observations without inventing their meaning", () => {
    expect(digestTerminalOutput("Loading\nLoading\nLoading\nDone")).toEqual({
      normalizedText: "Loading [repeated 3 times]\nDone",
      runs: [
        { text: "Loading", count: 3 },
        { text: "Done", count: 1 },
      ],
      sampleCount: 4,
      sourceCharacters: 28,
    });
  });
});
