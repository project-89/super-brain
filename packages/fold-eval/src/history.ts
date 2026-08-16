import {
  makeHistoryOracle,
  type HistoryOracleOptions,
  type HistoryRun,
} from "@_89/confidence-kernel";

import type { OracleHandler } from "./oracle.js";

export type { HistoryOracleOptions, HistoryRun } from "@_89/confidence-kernel";

export function createHistoryOracleHandler<S>(
  loadRuns: (subject: S) => HistoryRun[] | Promise<HistoryRun[]>,
  options: HistoryOracleOptions<S>,
): OracleHandler<S> {
  const oracle = makeHistoryOracle(loadRuns, options);
  return async (_spec, subject) => oracle.signal(subject);
}
