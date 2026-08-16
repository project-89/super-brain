import { combine as combineKernelResults } from "@_89/confidence-kernel";

import { runCommandOracle, type CommandOracleSpec, type CommandRunner } from "./command.js";

export const KNOWN_ORACLE_TYPES = ["command", "agent", "history", "checklist", "human"] as const;

export type OracleCombineStrategy = "min" | "mean" | "weighted" | "product";

export interface OracleSpec {
  readonly type: string;
  readonly weight?: number;
  readonly [key: string]: unknown;
}

export interface OracleSignal {
  readonly confidence: number;
  readonly detail?: string;
}

export type OracleHandler<S> = (
  oracle: OracleSpec,
  subject: S,
) => OracleSignal | undefined | Promise<OracleSignal | undefined>;

export interface OracleExecution {
  readonly type: string;
  readonly status: "present" | "absent";
  readonly confidence: number;
  readonly weight: number;
  readonly detail?: string;
}

export interface OracleEvaluation {
  readonly confidence: number;
  readonly combine: OracleCombineStrategy;
  readonly executions: readonly OracleExecution[];
  readonly detail?: string;
}

export interface VerifySpec {
  readonly oracles: readonly OracleSpec[];
  readonly combine?: OracleCombineStrategy;
}

export interface OracleExecutorOptions<S> {
  readonly handlers?: Readonly<Record<string, OracleHandler<S> | undefined>>;
  readonly knownTypes?: readonly string[];
  readonly commandRunner?: CommandRunner;
}

export class OracleConfigurationError extends Error {
  override readonly name = "OracleConfigurationError";
}

const COMBINE_STRATEGIES = new Set<OracleCombineStrategy>([
  "min",
  "mean",
  "weighted",
  "product",
]);

function assertUnitConfidence(confidence: number, context: string): void {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new OracleConfigurationError(`${context} emitted confidence outside [0,1]`);
  }
}

function weightOf(oracle: OracleSpec): number {
  const weight = oracle.weight ?? 1;
  if (!Number.isFinite(weight) || weight <= 0) {
    throw new OracleConfigurationError(`${oracle.type} oracle weight must be finite and greater than zero`);
  }
  return weight;
}

export function combineOracleExecutions(
  executions: readonly OracleExecution[],
  strategy: OracleCombineStrategy = "min",
): OracleSignal {
  if (!COMBINE_STRATEGIES.has(strategy)) {
    throw new OracleConfigurationError(`unknown oracle combine strategy: ${String(strategy)}`);
  }
  const present = executions.filter((execution) => execution.status === "present");
  if (present.length === 0) return { confidence: 1 };
  for (const execution of present) {
    assertUnitConfidence(execution.confidence, `${execution.type} oracle`);
    if (!Number.isFinite(execution.weight) || execution.weight <= 0) {
      throw new OracleConfigurationError(
        `${execution.type} oracle weight must be finite and greater than zero`,
      );
    }
  }
  const detailParts = present
    .map((execution) => execution.detail)
    .filter((detail): detail is string => detail !== undefined && detail.length > 0);
  const detail = detailParts.length === 0 ? undefined : detailParts.join("\n");

  if (strategy === "min" || strategy === "mean") {
    const result = combineKernelResults(present, strategy);
    return { confidence: result.confidence, ...(detail === undefined ? {} : { detail }) };
  }
  if (strategy === "product") {
    return {
      confidence: present.reduce((product, execution) => product * execution.confidence, 1),
      ...(detail === undefined ? {} : { detail }),
    };
  }

  const totalWeight = present.reduce((sum, execution) => sum + execution.weight, 0);
  const confidence = present.reduce(
    (sum, execution) => sum + execution.confidence * execution.weight,
    0,
  ) / totalWeight;
  return { confidence, ...(detail === undefined ? {} : { detail }) };
}

export async function evaluateOracles<S>(
  spec: VerifySpec,
  subject: S,
  options: OracleExecutorOptions<S> = {},
): Promise<OracleEvaluation> {
  const strategy = spec.combine ?? "min";
  if (!COMBINE_STRATEGIES.has(strategy)) {
    throw new OracleConfigurationError(`unknown oracle combine strategy: ${String(strategy)}`);
  }

  const handlers = new Map<string, OracleHandler<S>>();
  for (const [type, handler] of Object.entries(options.handlers ?? {})) {
    if (handler !== undefined) handlers.set(type, handler);
  }
  if (options.commandRunner !== undefined && !handlers.has("command")) {
    handlers.set("command", (oracle) =>
      runCommandOracle(oracle as unknown as CommandOracleSpec, options.commandRunner!),
    );
  }

  const knownTypes = new Set<string>([
    ...KNOWN_ORACLE_TYPES,
    ...(options.knownTypes ?? []),
    ...handlers.keys(),
  ]);

  // Validate the complete configuration before any handler can cause effects.
  for (const oracle of spec.oracles) {
    if (oracle.type.trim().length === 0 || !knownTypes.has(oracle.type)) {
      throw new OracleConfigurationError(`unknown oracle type: ${oracle.type || "(empty)"}`);
    }
    if (oracle.type === "command" && (typeof oracle.run !== "string" || oracle.run.trim() === "")) {
      throw new OracleConfigurationError("command oracle requires a non-empty run string");
    }
    weightOf(oracle);
  }

  const executions = await Promise.all(
    spec.oracles.map(async (oracle): Promise<OracleExecution> => {
      const weight = weightOf(oracle);
      const handler = handlers.get(oracle.type);
      if (handler === undefined) {
        return {
          type: oracle.type,
          status: "absent",
          confidence: 1,
          weight,
          detail: `${oracle.type} oracle - no handler configured: neutral`,
        };
      }
      const signal = await handler(oracle, subject);
      if (signal === undefined) {
        return {
          type: oracle.type,
          status: "absent",
          confidence: 1,
          weight,
          detail: `${oracle.type} oracle - no result: neutral`,
        };
      }
      assertUnitConfidence(signal.confidence, `${oracle.type} oracle`);
      return {
        type: oracle.type,
        status: "present",
        confidence: signal.confidence,
        weight,
        ...(signal.detail === undefined ? {} : { detail: signal.detail }),
      };
    }),
  );

  const combined = combineOracleExecutions(executions, strategy);
  return {
    confidence: combined.confidence,
    combine: strategy,
    executions,
    ...(combined.detail === undefined ? {} : { detail: combined.detail }),
  };
}
