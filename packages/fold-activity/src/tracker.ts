import { classifyTerminalState, isActiveTerminalState, mergeTerminalStateRules } from "./classifier.js";
import { normalizeForMatching } from "./normalize.js";
import type {
  TerminalClassification,
  TerminalFeedResult,
  TerminalStateRule,
} from "./types.js";

export interface TerminalStateTrackerOptions {
  readonly source?: string;
  readonly rules?: readonly TerminalStateRule[];
  readonly maxNormalizedBufferCharacters?: number;
}

export class TerminalStateTracker {
  private readonly source: string | undefined;
  private readonly rules: readonly TerminalStateRule[];
  private readonly maxCharacters: number;
  private normalizedTail = "";
  private current: TerminalClassification = { state: "unknown", confidence: 0.1 };
  private geminiReadySignals = 0;
  private geminiPendingActive: { state: string; ruleId?: string; count: number } | undefined;

  constructor(options: TerminalStateTrackerOptions = {}) {
    this.source = options.source;
    this.rules = mergeTerminalStateRules(options.rules);
    this.maxCharacters = options.maxNormalizedBufferCharacters ?? 20_000;
  }

  feed(rawChunk: string): TerminalFeedResult {
    const normalizedChunk = normalizeForMatching(rawChunk);
    if (normalizedChunk.length === 0) {
      return {
        normalizedChunk,
        normalizedTail: this.normalizedTail,
        classification: this.current,
        changed: false,
      };
    }

    const appended = `${this.normalizedTail} ${normalizedChunk}`.trim();
    this.normalizedTail = appended.slice(-this.maxCharacters);
    const classified = this.applyGeminiStability(
      classifyTerminalState(this.normalizedTail, this.rules, this.source),
    );
    const previous = this.current;
    const changed = classified.state !== previous.state;
    this.current = classified;

    return {
      normalizedChunk,
      normalizedTail: this.normalizedTail,
      classification: classified,
      changed,
      ...(changed
        ? {
            transition: {
              from: previous.state,
              to: classified.state,
              ...(classified.ruleId === undefined ? {} : { ruleId: classified.ruleId }),
            },
          }
        : {}),
    };
  }

  snapshot(): TerminalClassification {
    return this.current;
  }

  private applyGeminiStability(classified: TerminalClassification): TerminalClassification {
    if (this.source !== "gemini") return classified;

    if (classified.state === "ready_for_input") {
      this.geminiPendingActive = undefined;
      if (classified.ruleId === "ready_prompt_gemini_after_cancel") {
        this.geminiReadySignals = 0;
        return classified;
      }
      if (isActiveTerminalState(this.current.state)) {
        this.geminiReadySignals += 1;
        if (this.geminiReadySignals < 3) {
          return { ...this.current, confidence: Math.min(classified.confidence, 0.7) };
        }
      }
      this.geminiReadySignals = 0;
      return classified;
    }

    this.geminiReadySignals = 0;
    if (this.current.state !== "ready_for_input" || !isActiveTerminalState(classified.state)) {
      this.geminiPendingActive = undefined;
      return classified;
    }

    if (
      this.geminiPendingActive?.state === classified.state &&
      this.geminiPendingActive.ruleId === classified.ruleId
    ) {
      this.geminiPendingActive.count += 1;
    } else {
      this.geminiPendingActive = {
        state: classified.state,
        ...(classified.ruleId === undefined ? {} : { ruleId: classified.ruleId }),
        count: 1,
      };
    }
    if (this.geminiPendingActive.count < 2) {
      return { ...this.current, confidence: Math.min(classified.confidence, 0.72) };
    }
    this.geminiPendingActive = undefined;
    return classified;
  }
}
