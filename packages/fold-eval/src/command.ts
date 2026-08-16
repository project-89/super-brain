import type { OracleSignal } from "./oracle.js";

export interface CommandOracleSpec {
  readonly type: "command";
  readonly run: string;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly passConfidence?: number;
  readonly failConfidence?: number;
  readonly scorePattern?: string;
  readonly weight?: number;
}

export interface CommandRunRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
}

export interface CommandRunResult {
  readonly stdout?: string;
  readonly stderr?: string;
}

export type CommandRunner = (request: CommandRunRequest) => Promise<CommandRunResult>;

function assertConfidence(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${field} must be a finite number in [0,1]`);
  }
}

function outputFromFailure(error: unknown): string {
  if (typeof error !== "object" || error === null) return String(error);
  const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
  const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
  const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
  const combined = `${stdout}\n${stderr}`.trim();
  return combined || (typeof failure.message === "string" ? failure.message : String(error));
}

export async function runCommandOracle(
  oracle: CommandOracleSpec,
  runner: CommandRunner,
): Promise<OracleSignal> {
  if (oracle.run.trim().length === 0) throw new TypeError("command oracle run must not be empty");
  const pass = oracle.passConfidence ?? 1;
  const fail = oracle.failConfidence ?? 0;
  assertConfidence(pass, "passConfidence");
  assertConfidence(fail, "failConfidence");

  let scoreRegex: RegExp | undefined;
  if (oracle.scorePattern !== undefined) {
    try {
      scoreRegex = new RegExp(oracle.scorePattern);
    } catch (error) {
      throw new TypeError(
        `command oracle scorePattern is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const scoreFrom = (output: string): number | undefined => {
    if (scoreRegex === undefined) return undefined;
    const match = output.match(scoreRegex);
    if (match?.[1] === undefined || match[2] === undefined) return undefined;
    const passed = Number(match[1]);
    const failed = Number(match[2]);
    const total = passed + failed;
    if (!Number.isFinite(passed) || !Number.isFinite(failed) || passed < 0 || failed < 0 || total <= 0) {
      return undefined;
    }
    return passed / total;
  };

  try {
    const result = await runner({
      command: oracle.run,
      ...(oracle.cwd === undefined ? {} : { cwd: oracle.cwd }),
      timeoutMs: oracle.timeoutMs ?? 120_000,
      maxBufferBytes: 10 * 1024 * 1024,
    });
    const score = scoreFrom(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
    return score === undefined
      ? { confidence: pass, detail: `\`${oracle.run}\` - passed` }
      : {
          confidence: score,
          detail: `\`${oracle.run}\` - partial (${(score * 100).toFixed(0)}%)`,
        };
  } catch (error) {
    const output = outputFromFailure(error);
    const score = scoreFrom(output);
    return score === undefined
      ? { confidence: fail, detail: `\`${oracle.run}\` - failed:\n${output.slice(-800)}` }
      : {
          confidence: score,
          detail: `\`${oracle.run}\` - partial (${(score * 100).toFixed(0)}%)\n${output.slice(-800)}`,
        };
  }
}
