import { describe, expect, it } from "vitest";

import { parseConfidenceMarker, parseReviewVerdict } from "../src/index.js";

describe("parseReviewVerdict", () => {
  it("parses approve and supplies protocol defaults", () => {
    expect(parseReviewVerdict("VERDICT: approve\nCONFIDENCE: 0.95")).toMatchObject({
      verdict: "approve",
      confidence: 0.95,
    });
    expect(parseReviewVerdict("VERDICT: approve").confidence).toBe(0.9);
  });

  it("clamps revise and reject so contradictory confidence cannot approve work", () => {
    expect(parseReviewVerdict("VERDICT: revise\nCONFIDENCE: 0.8").confidence).toBe(0.6);
    expect(parseReviewVerdict("VERDICT: revise").confidence).toBe(0.5);
    expect(parseReviewVerdict("VERDICT: reject\nCONFIDENCE: 0.9").confidence).toBe(0.3);
    expect(parseReviewVerdict("VERDICT: reject").confidence).toBe(0.1);
  });

  it("uses the last verdict and tolerates accept as approve", () => {
    expect(
      parseReviewVerdict(
        "Format: VERDICT: approve | revise | reject\nVERDICT: reject\nCONFIDENCE: 0.15",
      ),
    ).toMatchObject({ verdict: "reject", confidence: 0.15 });
    expect(parseReviewVerdict("VERDICT: accept").verdict).toBe("approve");
  });

  it("preserves a bare marker and keeps absence distinct", () => {
    expect(parseReviewVerdict("All good. CONFIDENCE: 0.7")).toMatchObject({ confidence: 0.7 });
    expect(parseReviewVerdict("No structured result")).toEqual({
      detail: "No structured result",
    });
  });

  it("parses raw terminal frames and clamps markers into the unit interval", () => {
    const parsed = parseReviewVerdict(
      "\u001b[38;2;1;2;3mDone.\u001b[39m\r\nVERDICT:\u001b[2C reject\nCONFIDENCE: 0.2\u001b[K",
    );
    expect(parsed).toMatchObject({ verdict: "reject", confidence: 0.2 });
    expect(parseConfidenceMarker("CONFIDENCE: 4")).toBe(1);
  });
});
