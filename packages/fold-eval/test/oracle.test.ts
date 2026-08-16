import { describe, expect, it, vi } from "vitest";

import {
  combineOracleExecutions,
  createHistoryOracleHandler,
  evaluateOracles,
  OracleConfigurationError,
  type HistoryRun,
  type OracleCombineStrategy,
  type OracleHandler,
} from "../src/index.js";

describe("combineOracleExecutions", () => {
  it("validates direct callers with the same fail-closed rules", () => {
    expect(() =>
      combineOracleExecutions([], "mystery" as OracleCombineStrategy),
    ).toThrow(/unknown oracle combine strategy/);
    expect(() =>
      combineOracleExecutions([
        { type: "test", status: "present", confidence: 2, weight: 1 },
      ]),
    ).toThrow(/outside \[0,1\]/);
  });
});

describe("evaluateOracles", () => {
  it("validates every type before running any handler", async () => {
    const command = vi.fn<OracleHandler<unknown>>().mockReturnValue({ confidence: 1 });
    await expect(
      evaluateOracles(
        { oracles: [{ type: "command", run: "test" }, { type: "mystery" }] },
        {},
        { handlers: { command } },
      ),
    ).rejects.toThrow(new OracleConfigurationError("unknown oracle type: mystery"));
    expect(command).not.toHaveBeenCalled();
  });

  it("represents known-but-unavailable or missing results as absent and neutral", async () => {
    const result = await evaluateOracles(
      { oracles: [{ type: "agent" }, { type: "history" }] },
      {},
      { handlers: { history: async () => undefined } },
    );
    expect(result.confidence).toBe(1);
    expect(result.executions.map((execution) => execution.status)).toEqual(["absent", "absent"]);
  });

  it("excludes absent signals from every combine strategy", async () => {
    const handlers = {
      agent: async () => ({ confidence: 0.2 }),
      history: async () => undefined,
    };
    for (const combine of ["min", "mean", "weighted", "product"] as const) {
      const result = await evaluateOracles(
        { oracles: [{ type: "agent" }, { type: "history", weight: 100 }], combine },
        {},
        { handlers },
      );
      expect(result.confidence).toBeCloseTo(0.2, 12);
    }
  });

  it.each<[OracleCombineStrategy, number]>([
    ["min", 0.2],
    ["mean", 0.5],
    ["weighted", 0.65],
    ["product", 0.16],
  ])("honors the %s combine strategy", async (combine, expected) => {
    const result = await evaluateOracles(
      {
        oracles: [
          { type: "low", score: 0.2, weight: 1 },
          { type: "high", score: 0.8, weight: 3 },
        ],
        combine,
      },
      {},
      {
        handlers: {
          low: (oracle) => ({ confidence: Number(oracle.score), detail: "low" }),
          high: (oracle) => ({ confidence: Number(oracle.score), detail: "high" }),
        },
      },
    );
    expect(result.confidence).toBeCloseTo(expected, 12);
    expect(result.detail).toBe("low\nhigh");
  });

  it("rejects invalid weights and handler confidences", async () => {
    await expect(
      evaluateOracles({ oracles: [{ type: "agent", weight: 0 }] }, {}),
    ).rejects.toThrow(/weight/);
    await expect(
      evaluateOracles(
        { oracles: [{ type: "agent" }] },
        {},
        { handlers: { agent: async () => ({ confidence: Number.NaN }) } },
      ),
    ).rejects.toThrow(/outside \[0,1\]/);
  });

  it("rejects malformed command specs and unknown combine modes before execution", async () => {
    const command = vi.fn<OracleHandler<unknown>>().mockReturnValue({ confidence: 1 });
    await expect(
      evaluateOracles({ oracles: [{ type: "command" }] }, {}, { handlers: { command } }),
    ).rejects.toThrow(/requires a non-empty run string/);
    await expect(
      evaluateOracles(
        {
          oracles: [{ type: "agent" }],
          combine: "mystery" as OracleCombineStrategy,
        },
        {},
      ),
    ).rejects.toThrow(/unknown oracle combine strategy/);
    expect(command).not.toHaveBeenCalled();
  });

  it("runs command specs through an injected runner", async () => {
    const result = await evaluateOracles(
      { oracles: [{ type: "command", run: "verify" }] },
      {},
      { commandRunner: async () => ({ stdout: "ok" }) },
    );
    expect(result.confidence).toBe(1);
    expect(result.executions[0]).toMatchObject({ type: "command", status: "present" });
  });
});

describe("confidence-kernel history integration", () => {
  const now = Date.UTC(2026, 7, 14);
  const runs = (outcomes: HistoryRun["outcome"][]): HistoryRun[] =>
    outcomes.map((outcome, index) => ({ id: String(index), timestamp: now, outcome }));
  const options = {
    posture: "suppress" as const,
    halfLifeDays: 30,
    saturationRuns: 10,
    minRuns: 3,
    now,
  };

  it("keeps thin history neutral and scores sufficient history through the kernel", async () => {
    const thin = createHistoryOracleHandler(async () => runs(["failure", "failure"]), options);
    const sufficient = createHistoryOracleHandler(
      async () => runs(["failure", "failure", "failure"]),
      options,
    );
    const thinResult = await evaluateOracles(
      { oracles: [{ type: "history" }] },
      {},
      { handlers: { history: thin } },
    );
    const scoredResult = await evaluateOracles(
      { oracles: [{ type: "history" }] },
      {},
      { handlers: { history: sufficient } },
    );
    expect(thinResult.confidence).toBe(1);
    expect(scoredResult.confidence).toBeCloseTo(0.7, 12);
  });
});
