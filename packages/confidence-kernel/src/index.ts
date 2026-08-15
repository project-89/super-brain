export type {
  HistoryRun,
  Posture,
  DecayBase,
  ScoreOptions,
  ScoreResult,
  OracleResult,
  Oracle,
  Journal,
} from './types.js';

export { ageDecayWeight, efficiencyFactor, scoreHistory } from './score.js';
export { detectDrift } from './drift.js';
export type { DriftOptions, DriftResult } from './drift.js';
export { combine, makeHistoryOracle } from './oracle.js';
export type { CombineStrategy, HistoryOracleOptions } from './oracle.js';
export { pool } from './pool.js';
export { applyProbation, shouldRetire } from './curate.js';
export type {
  ProbationOptions,
  ProbationResult,
  FastKillOptions,
} from './curate.js';
export { InMemoryJournal, JsonlJournal } from './journal.js';
export type { JsonlFs } from './journal.js';
