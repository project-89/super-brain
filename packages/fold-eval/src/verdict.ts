export const REVIEW_PROTOCOL_INSTRUCTION =
  "End your review with exactly two lines:\n" +
  "VERDICT: approve | revise | reject\n" +
  "CONFIDENCE: <0.0-1.0> - your confidence that the work fully satisfies the task";

export type ReviewVerdictWord = "approve" | "revise" | "reject";

export interface ReviewVerdict {
  readonly confidence?: number;
  readonly verdict?: ReviewVerdictWord;
  readonly detail: string;
}

export function stripTerminalSequences(text: string): string {
  if (!text) return "";
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b./g, "")
    .replace(/\r/g, "");
}

export function parseConfidenceMarker(text: string): number | undefined {
  const matches = stripTerminalSequences(text).match(/confidence:\s*([0-9]*\.?[0-9]+)/gi);
  const last = matches?.at(-1);
  if (last === undefined) return undefined;
  const value = Number.parseFloat(last.replace(/confidence:\s*/i, ""));
  if (Number.isNaN(value)) return undefined;
  return Math.min(Math.max(value, 0), 1);
}

export function parseReviewVerdict(text: string): ReviewVerdict {
  const clean = stripTerminalSequences(text ?? "").trim();
  const detail = clean.slice(-1200);
  const matches = clean.match(/verdict:\s*(approve|accept|revise|reject)/gi);
  const last = matches?.at(-1);
  const verdict = last
    ? (last
        .replace(/verdict:\s*/i, "")
        .toLowerCase()
        .replace("accept", "approve") as ReviewVerdictWord)
    : undefined;
  const marker = parseConfidenceMarker(clean);

  let confidence: number | undefined;
  if (verdict === "approve") confidence = marker ?? 0.9;
  else if (verdict === "revise") confidence = Math.min(marker ?? 0.5, 0.6);
  else if (verdict === "reject") confidence = Math.min(marker ?? 0.1, 0.3);
  else confidence = marker;

  return {
    ...(confidence === undefined ? {} : { confidence }),
    ...(verdict === undefined ? {} : { verdict }),
    detail,
  };
}
