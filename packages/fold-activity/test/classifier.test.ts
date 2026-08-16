import { describe, expect, it } from "vitest";

import {
  classifyTerminalState,
  normalizeForMatching,
  TerminalStateTracker,
} from "../src/index.js";

describe("terminal state classification", () => {
  it("recognizes source-scoped Claude states", () => {
    expect(
      classifyTerminalState(
        normalizeForMatching("Interrupted · What should Claude do instead?"),
        undefined,
        "claude",
      ),
    ).toMatchObject({ state: "awaiting_input", ruleId: "awaiting_input_claude_interrupted" });
    expect(
      classifyTerminalState(
        normalizeForMatching("Do you want to proceed? 1. Yes 2. Yes, and don't ask again"),
        undefined,
        "claude",
      ),
    ).toMatchObject({ state: "awaiting_approval", ruleId: "awaiting_approval_claude_menu" });
    expect(
      classifyTerminalState(normalizeForMatching('❯ Try "fix lint" ? for shortcuts'), undefined, "claude"),
    ).toMatchObject({ state: "ready_for_input", ruleId: "ready_prompt_claude" });
  });

  it("does not apply another adapter's source-scoped rules", () => {
    expect(
      classifyTerminalState(normalizeForMatching("Type your message or @path/to/file"), undefined, "claude"),
    ).toEqual({ state: "unknown", confidence: 0.2 });
  });

  it("prefers an active Gemini overlay over its visible composer", () => {
    expect(
      classifyTerminalState(
        normalizeForMatching("Apply this change? > Type your message or @path/to/file"),
        undefined,
        "gemini",
      ),
    ).toMatchObject({ state: "awaiting_approval", ruleId: "awaiting_approval_gemini" });
  });

  it("uses only the recent classification window", () => {
    const stale = `Cooked for 41s ${"x".repeat(4_100)}`;
    expect(classifyTerminalState(stale, undefined, "claude").state).toBe("unknown");
  });
});

describe("TerminalStateTracker", () => {
  it("emits transitions and ignores control-only chunks", () => {
    const tracker = new TerminalStateTracker({ source: "codex" });
    expect(tracker.feed("\u001b[?2004h\u001b[6n").changed).toBe(false);
    const ready = tracker.feed("› Ask Codex to do anything");
    expect(ready.changed).toBe(true);
    expect(ready.transition).toEqual({
      from: "unknown",
      to: "ready_for_input",
      ruleId: "ready_prompt_codex",
    });
  });

  it("requires repeated Gemini frames for active-to-ready and ready-to-active changes", () => {
    const tracker = new TerminalStateTracker({
      source: "gemini",
      maxNormalizedBufferCharacters: 140,
    });
    expect(tracker.feed("Loading (esc to cancel)").classification.state).toBe("busy_streaming");
    const readyFrame = `${"x".repeat(180)} > Type your message or @path/to/file`;
    expect(tracker.feed(readyFrame).classification.state).toBe("busy_streaming");
    expect(tracker.feed(readyFrame).classification.state).toBe("busy_streaming");
    expect(tracker.feed(readyFrame).classification.state).toBe("ready_for_input");
    expect(tracker.feed("Loading (esc to cancel)").classification.state).toBe("ready_for_input");
    expect(tracker.feed("Loading (esc to cancel)").classification.state).toBe("busy_streaming");
  });
});
