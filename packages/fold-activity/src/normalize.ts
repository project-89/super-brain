import type { TerminalOutputDigest, TerminalOutputRun } from "./types.js";

const CURSOR_FORWARD = /\u001b\[(\d+)C/g;
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_SINGLE = /\u001b[@-_]/g;
const FRAGMENTED_SGR = /\b(?:\d{1,3}\s*;\s*){2,10}\d{1,3}m\b/g;

export function stripAnsiPreserveText(input: string): string {
  return input
    .replace(CURSOR_FORWARD, (_match, count: string) =>
      " ".repeat(Math.max(Number.parseInt(count, 10) || 0, 0)),
    )
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_SINGLE, "");
}

function normalizeVisibleText(input: string): string {
  return input
    .replace(FRAGMENTED_SGR, " ")
    .replace(/[\u2500-\u257f]/g, " ")
    .replace(/[\u2580-\u259f]/g, " ")
    .replace(/[\u2800-\u28ff]/g, " ")
    .replace(/[\t ]{2,}/g, " ")
    .trim();
}

export function normalizeForMatching(input: string): string {
  return normalizeVisibleText(stripAnsiPreserveText(input).replace(/[\r\n\t]+/g, " "));
}

export function digestTerminalOutput(input: string): TerminalOutputDigest {
  const lines = stripAnsiPreserveText(input)
    .replace(/\r/g, "")
    .split("\n")
    .map(normalizeVisibleText)
    .filter((line) => line.length > 0);

  const runs: TerminalOutputRun[] = [];
  for (const line of lines) {
    const previous = runs.at(-1);
    if (previous?.text === line) {
      runs[runs.length - 1] = { text: line, count: previous.count + 1 };
    } else {
      runs.push({ text: line, count: 1 });
    }
  }

  return {
    normalizedText: runs
      .map((run) => (run.count === 1 ? run.text : `${run.text} [repeated ${run.count} times]`))
      .join("\n"),
    runs,
    sampleCount: lines.length,
    sourceCharacters: input.length,
  };
}
