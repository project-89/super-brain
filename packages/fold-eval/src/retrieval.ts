import { createHash } from "node:crypto";

export interface RetrievalEvidence {
  readonly eventId: string;
  readonly projectId?: string;
  readonly runId?: string;
  readonly turnId?: string;
}

export interface RetrievalQuestion {
  readonly id: string;
  readonly query: string;
  readonly expectedEvidence: readonly RetrievalEvidence[];
  readonly rationale: string;
}

export interface RetrievalSuite {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly projectId: string;
  readonly topK: number;
  readonly groundTruth: {
    readonly status: "reviewed";
    readonly reviewer: string;
    readonly reviewedAt: string;
    readonly selectionMethod: string;
  };
  readonly questions: readonly RetrievalQuestion[];
}

export interface RetrievalResponse {
  readonly ranking: { readonly id: string; readonly kind: string; readonly corpusSize: number };
  readonly memories: readonly {
    readonly score?: number;
    readonly memory: {
      readonly id: string;
      readonly workspaceId: string;
      readonly projectIds: readonly string[];
      readonly summary: string;
      readonly revision: number;
      readonly evidence?: readonly RetrievalEvidence[];
      readonly [key: string]: unknown;
    };
  }[];
}

export interface RetrievalQuestionResult {
  readonly questionId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly response: RetrievalResponse;
  readonly matchedExpectedEvidence: readonly RetrievalEvidence[];
  readonly firstEvidenceMatchRank: number | null;
}

export interface Fraction {
  readonly numerator: number;
  readonly denominator: number;
  readonly value: number | null;
}

export interface RetrievalRun {
  readonly schemaVersion: 1;
  readonly suite: RetrievalSuite;
  readonly suiteHash: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly results: readonly RetrievalQuestionResult[];
  readonly metrics: {
    readonly questions: number;
    readonly retrieved: number;
    readonly requestedSlots: number;
    readonly evidenceCoverage: Fraction;
    readonly questionsWithEvidenceMatch: Fraction;
    readonly retrievedWithEvidence: Fraction;
    readonly meanReciprocalEvidenceRank: Fraction;
  };
  readonly limitations: readonly string[];
  readonly runHash: string;
}

export interface RetrievalJudgments {
  readonly schemaVersion: 1;
  readonly runHash: string;
  readonly judgments: readonly {
    readonly status: "reviewed";
    readonly questionId: string;
    readonly memoryId: string;
    readonly signal: "helpful" | "unhelpful" | "superseded";
    readonly reviewer: string;
    readonly recordedAt: string;
    readonly reason: string;
  }[];
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string, max = 2_000): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) throw new Error(`${name} must contain 1 to ${max} characters`);
  return value;
}

function list(value: unknown, name: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) throw new Error(`${name} must contain ${min} to ${max} entries`);
  return value;
}

function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${name} must be an integer within [${min}, ${max}]`);
  return value as number;
}

function date(value: unknown, name: string): string {
  const result = string(value, name, 50);
  if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`${name} must be an ISO timestamp with timezone`);
  return result;
}

function unique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${name} must be unique`);
}

function parseEvidence(value: unknown): RetrievalEvidence {
  const input = object(value, "evidence");
  return {
    eventId: string(input.eventId, "evidence.eventId", 500),
    ...(input.projectId === undefined ? {} : { projectId: string(input.projectId, "evidence.projectId", 300) }),
    ...(input.runId === undefined ? {} : { runId: string(input.runId, "evidence.runId", 500) }),
    ...(input.turnId === undefined ? {} : { turnId: string(input.turnId, "evidence.turnId", 500) }),
  };
}

export function retrievalHash(value: unknown): string {
  function canonical(input: unknown): unknown {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") return Object.fromEntries(
      Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]),
    );
    return input;
  }
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

export function parseRetrievalSuite(value: unknown): RetrievalSuite {
  const input = object(value, "suite");
  if (input.schemaVersion !== 1) throw new Error("Unsupported suite schemaVersion");
  const projectId = string(input.projectId, "projectId", 300);
  const groundTruth = object(input.groundTruth, "groundTruth");
  if (groundTruth.status !== "reviewed") throw new Error("Ground truth is unreviewed; inspect sources and explicitly mark it reviewed first");
  const questions = list(input.questions, "questions", 1, 100).map((value): RetrievalQuestion => {
    const question = object(value, "question");
    const expectedEvidence = list(question.expectedEvidence, "expectedEvidence", 1, 100).map(parseEvidence);
    unique(expectedEvidence.map(retrievalHash), "Expected evidence references");
    if (expectedEvidence.some((evidence) => evidence.projectId !== undefined && evidence.projectId !== projectId)) throw new Error("Expected evidence must belong to the suite project");
    return {
      id: string(question.id, "question.id", 300),
      query: string(question.query, "question.query", 500),
      expectedEvidence,
      rationale: string(question.rationale, "question.rationale"),
    };
  });
  unique(questions.map(({ id }) => id), "Question IDs");
  return {
    schemaVersion: 1,
    id: string(input.id, "suite.id", 300),
    organizationId: string(input.organizationId, "organizationId", 300),
    workspaceId: string(input.workspaceId, "workspaceId", 300),
    projectId,
    topK: integer(input.topK, "topK", 1, 100),
    groundTruth: {
      status: "reviewed",
      reviewer: string(groundTruth.reviewer, "groundTruth.reviewer", 300),
      reviewedAt: date(groundTruth.reviewedAt, "groundTruth.reviewedAt"),
      selectionMethod: string(groundTruth.selectionMethod, "groundTruth.selectionMethod"),
    },
    questions,
  };
}

function parseResponse(value: unknown, suite: RetrievalSuite): RetrievalResponse {
  const response = object(value, "response");
  const ranking = object(response.ranking, "ranking");
  const memories = list(response.memories, "memories", 0, suite.topK).map((entry) => {
    const result = object(entry, "result");
    const memory = object(result.memory, "memory");
    const workspaceId = string(memory.workspaceId, "memory.workspaceId", 300);
    const projectIds = list(memory.projectIds, "memory.projectIds", 1, 1000).map((id) => string(id, "projectId", 300));
    if (workspaceId !== suite.workspaceId || !projectIds.includes(suite.projectId)) throw new Error("Recall returned an out-of-scope memory; evaluation refused");
    if (result.score !== undefined && (typeof result.score !== "number" || !Number.isFinite(result.score))) throw new Error("Invalid ranking score");
    return {
      ...(result.score === undefined ? {} : { score: result.score as number }),
      memory: {
        ...memory,
        id: string(memory.id, "memory.id", 500),
        workspaceId,
        projectIds,
        summary: typeof memory.summary === "string" ? memory.summary : "",
        revision: integer(memory.revision, "memory.revision", 0, Number.MAX_SAFE_INTEGER),
        ...(memory.evidence === undefined ? {} : { evidence: list(memory.evidence, "memory.evidence", 0, 100_000).map(parseEvidence) }),
      },
    };
  });
  unique(memories.map(({ memory }) => memory.id), "Returned memory IDs");
  const corpusSize = integer(ranking.corpusSize, "ranking.corpusSize", memories.length, Number.MAX_SAFE_INTEGER);
  return { memories, ranking: { id: string(ranking.id, "ranking.id", 300), kind: string(ranking.kind, "ranking.kind", 300), corpusSize } };
}

function matches(expected: RetrievalEvidence, actual: RetrievalEvidence): boolean {
  return expected.eventId === actual.eventId
    && (expected.projectId === undefined || expected.projectId === actual.projectId)
    && (expected.runId === undefined || expected.runId === actual.runId)
    && (expected.turnId === undefined || expected.turnId === actual.turnId);
}

function fraction(numerator: number, denominator: number): Fraction {
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

function questionResult(question: RetrievalQuestion, response: RetrievalResponse, startedAt: string, finishedAt: string): RetrievalQuestionResult {
  const matchedExpectedEvidence = question.expectedEvidence.filter((expected) => response.memories.some(({ memory }) => memory.evidence?.some((actual) => matches(expected, actual))));
  const first = response.memories.findIndex(({ memory }) => memory.evidence?.some((actual) => question.expectedEvidence.some((expected) => matches(expected, actual))));
  return { questionId: question.id, startedAt, finishedAt, response, matchedExpectedEvidence, firstEvidenceMatchRank: first < 0 ? null : first + 1 };
}

function metrics(suite: RetrievalSuite, results: readonly RetrievalQuestionResult[]): RetrievalRun["metrics"] {
  const retrieved = results.reduce((sum, result) => sum + result.response.memories.length, 0);
  return {
    questions: results.length,
    retrieved,
    requestedSlots: suite.topK * suite.questions.length,
    evidenceCoverage: fraction(results.reduce((sum, result) => sum + result.matchedExpectedEvidence.length, 0), suite.questions.reduce((sum, question) => sum + question.expectedEvidence.length, 0)),
    questionsWithEvidenceMatch: fraction(results.filter((result) => result.firstEvidenceMatchRank !== null).length, results.length),
    retrievedWithEvidence: fraction(results.reduce((sum, result) => sum + result.response.memories.filter(({ memory }) => (memory.evidence?.length ?? 0) > 0).length, 0), retrieved),
    meanReciprocalEvidenceRank: fraction(results.reduce((sum, result) => sum + (result.firstEvidenceMatchRank === null ? 0 : 1 / result.firstEvidenceMatchRank), 0), results.length),
  };
}

const LIMITATIONS = [
  "Expected-source matches measure reference overlap, not answer correctness or semantic relevance.",
  "Source reachability and semantic alignment are not measured by this runner.",
  "Each recall sees the current authorized project corpus; requests are not an atomic database snapshot. Corpus sizes and memory revisions are recorded per question.",
  "Reviewer identities and expected sources are operator-supplied, not authenticated human attestations.",
  "Top-k results are not the entire corpus. Unjudged results are unknown, not unhelpful. No memory is promoted or marked helpful by this run.",
] as const;

export async function runRetrievalEvaluation(
  input: unknown,
  recall: (suite: RetrievalSuite, question: RetrievalQuestion) => Promise<unknown>,
  now: () => string = () => new Date().toISOString(),
): Promise<RetrievalRun> {
  const suite = parseRetrievalSuite(input);
  const startedAt = now();
  const results: RetrievalQuestionResult[] = [];
  for (const question of suite.questions) {
    const questionStartedAt = now();
    const response = parseResponse(await recall(suite, question), suite);
    results.push(questionResult(question, response, questionStartedAt, now()));
  }
  const report = { schemaVersion: 1 as const, suite, suiteHash: retrievalHash(suite), startedAt, finishedAt: now(), results, metrics: metrics(suite, results), limitations: LIMITATIONS };
  return { ...report, runHash: retrievalHash(report) };
}

export function validateRetrievalRun(value: unknown): RetrievalRun {
  const input = object(value, "run");
  const { runHash, ...body } = input;
  if (input.schemaVersion !== 1 || runHash !== retrievalHash(body)) throw new Error("Retrieval run hash mismatch or unsupported schema");
  const suite = parseRetrievalSuite(input.suite);
  if (input.suiteHash !== retrievalHash(suite)) throw new Error("Suite hash mismatch");
  const results = list(input.results, "results", suite.questions.length, suite.questions.length).map((value, index) => {
    const result = object(value, "result");
    const question = suite.questions[index]!;
    if (result.questionId !== question.id) throw new Error("Question results do not match suite order");
    const rebuilt = questionResult(question, parseResponse(result.response, suite), date(result.startedAt, "startedAt"), date(result.finishedAt, "finishedAt"));
    if (retrievalHash(rebuilt) !== retrievalHash(result)) throw new Error("Invalid question metrics");
    return rebuilt;
  });
  if (retrievalHash(metrics(suite, results)) !== retrievalHash(input.metrics)) throw new Error("Invalid aggregate metrics");
  date(input.startedAt, "startedAt");
  date(input.finishedAt, "finishedAt");
  return input as unknown as RetrievalRun;
}

export function summarizeRetrievalJudgments(runInput: unknown, judgmentsInput: unknown) {
  const run = validateRetrievalRun(runInput);
  const input = object(judgmentsInput, "judgments");
  if (input.schemaVersion !== 1 || input.runHash !== run.runHash) throw new Error("Judgments must reference this exact retrieval run");
  const judgments = list(input.judgments, "judgments", 0, run.metrics.retrieved).map((value) => {
    const judgment = object(value, "judgment");
    if (judgment.status !== "reviewed") throw new Error("Judgment is unreviewed; review it or omit it for partial coverage");
    const questionId = string(judgment.questionId, "questionId", 300);
    const memoryId = string(judgment.memoryId, "memoryId", 500);
    if (!run.results.find((result) => result.questionId === questionId)?.response.memories.some(({ memory }) => memory.id === memoryId)) throw new Error("Judgment references a memory not returned for this question");
    const signal = judgment.signal;
    if (signal !== "helpful" && signal !== "unhelpful" && signal !== "superseded") throw new Error("Judgment requires an explicit helpful, unhelpful, or superseded signal");
    return { status: "reviewed" as const, questionId, memoryId, signal, reviewer: string(judgment.reviewer, "reviewer", 300), recordedAt: date(judgment.recordedAt, "recordedAt"), reason: string(judgment.reason, "reason") };
  });
  unique(judgments.map(({ questionId, memoryId }) => JSON.stringify([questionId, memoryId])), "Question/memory judgments");
  const report = {
    schemaVersion: 1,
    runHash: run.runHash,
    suiteHash: run.suiteHash,
    judgments,
    metrics: {
      retrieved: run.metrics.retrieved,
      judged: judgments.length,
      unjudged: run.metrics.retrieved - judgments.length,
      helpful: judgments.filter(({ signal }) => signal === "helpful").length,
      unhelpful: judgments.filter(({ signal }) => signal === "unhelpful").length,
      superseded: judgments.filter(({ signal }) => signal === "superseded").length,
      judgmentCoverage: fraction(judgments.length, run.metrics.retrieved),
      helpfulAmongJudged: fraction(judgments.filter(({ signal }) => signal === "helpful").length, judgments.length),
    },
    limitations: LIMITATIONS,
  };
  return { ...report, reportHash: retrievalHash(report) };
}
